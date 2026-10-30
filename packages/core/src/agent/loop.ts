import path from "node:path";
import { v4 as uuid } from "uuid";
import type {
  AgentConfirmation,
  AgentEvent,
  AgentPlanStep,
  AppSettings,
  GenerationParams,
} from "@kovi/shared";
import type { ChatEngine } from "../chat/engine.js";
import type { Store } from "../db/store.js";
import type { McpManager } from "../mcp/manager.js";
import { BrowserTooling } from "../tools/browser.js";
import {
  applyPatchTool,
  deletePathTool,
  listDir,
  readFileTool,
  searchFiles,
  writeFileTool,
} from "../tools/files.js";
import { cancelActiveTerminals, runTerminal } from "../tools/terminal.js";
import { previewPatchDiff, previewWriteDiff } from "../tools/diff.js";
import {
  approvalRememberKey,
  resolveAgentPath,
  riskForTool,
  shouldConfirmRisk,
} from "../tools/sandbox.js";
import { webSearch } from "../tools/websearch.js";
import {
  estimateMessagesTokens,
  fitMessagesToContext,
  isContextOverflowError,
} from "../chat/contextBudget.js";
import { isLlmTruncatedError } from "../chat/llmErrors.js";
import { projectContextCache } from "../context/projectCache.js";
import { buildProjectContext } from "../context/packer.js";
import { getLastSemanticError } from "../context/retrieve.js";
import { formatRetrievedSnippets } from "../context/retrieve.js";
import { invalidateIndexPaths } from "../context/semanticIndex.js";
import { condenseTranscript, summarizeTranscript } from "../context/summarize.js";
import { detectCodingTask } from "./intent.js";
import {
  agentTuningForFamily,
  detectModelFamily,
} from "../models/modelFamily.js";
import {
  currentPlanStep,
  defaultPlanForTask,
  executePhaseHint,
  markCurrentPlanDone,
  markCurrentPlanFailed,
  normalizePlanDraft,
  PLAN_PHASE_MAX_ATTEMPTS,
  planPhaseInstruction,
  skipRemainingPlan,
} from "./planner.js";
import {
  parseAgentAction,
  PLAN_ADVANCING_TOOLS,
  validateToolArgs,
} from "./parseAction.js";
import { toolsPromptBlock } from "./toolsCatalog.js";
import {
  applyWorkingMemoryToSystem,
  createWorkingMemory,
  emergencyShrinkTranscript,
  parseWorkingMemory,
  rememberToolError,
  rememberToolSuccess,
  serializeWorkingMemory,
  updatePlanMemory,
} from "./workingMemory.js";

const TOOL_RESULT_TRANSCRIPT_CHARS = 2_500;
const PRIOR_LOOKBACK_MESSAGES = 14;

/** Alias common model mistakes before path normalization. */
function coerceToolArgs(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...args };
  if ((next.path == null || String(next.path).trim() === "") && next.file != null) {
    next.path = next.file;
  }
  if ((next.path == null || String(next.path).trim() === "") && next.filename != null) {
    next.path = next.filename;
  }
  if ((next.path == null || String(next.path).trim() === "") && next.filepath != null) {
    next.path = next.filepath;
  }
  if (toolName === "write_file" && (next.content == null || next.content === "")) {
    if (typeof next.text === "string") next.content = next.text;
    else if (typeof next.code === "string") next.content = next.code;
    else if (typeof next.body === "string") next.content = next.body;
    else if (typeof next.source === "string") next.content = next.source;
  }
  if (toolName === "apply_patch") {
    if (next.oldText == null && typeof next.old === "string") next.oldText = next.old;
    if (next.newText == null && typeof next.new === "string") next.newText = next.new;
    if (next.oldText == null && typeof next.before === "string") next.oldText = next.before;
    if (next.newText == null && typeof next.after === "string") next.newText = next.after;
  }
  if (toolName === "run_terminal") {
    if ((next.cwd == null || String(next.cwd).trim() === "") && next.dir != null) {
      next.cwd = next.dir;
    }
    if ((next.cwd == null || String(next.cwd).trim() === "") && next.workdir != null) {
      next.cwd = next.workdir;
    }
    if ((next.command == null || String(next.command).trim() === "") && next.cmd != null) {
      next.command = next.cmd;
    }
  }
  return next;
}

/** Normalize path-like tool args to absolute Windows paths under projectRoot. */
function normalizeToolArgs(
  toolName: string,
  args: Record<string, unknown>,
  projectRoot: string | null,
): Record<string, unknown> {
  const next = coerceToolArgs(toolName, args);
  const pathKeys =
    toolName === "run_terminal"
      ? (["cwd", "dir", "workdir"] as const)
      : (["path", "file"] as const);
  for (const key of pathKeys) {
    if (!(key in next)) continue;
    const raw = next[key];
    if (raw == null || String(raw).trim() === "") {
      if (toolName === "run_terminal" && projectRoot) {
        next[key] = projectRoot;
      }
      continue;
    }
    try {
      next[key] = resolveAgentPath(raw, projectRoot, {
        allowBlankAsProject: toolName === "run_terminal",
      });
    } catch {
      // leave raw; tool will throw with a clear error
    }
  }
  return next;
}

const FILE_MUTATION_TOOLS = new Set(["write_file", "apply_patch"]);
/** Heuristic: stub/skeleton writes that should not unlock final for coding tasks. */
const MIN_CODING_WRITE_CHARS = 400;

function minWriteCharsForPath(filePath: string): number {
  const ext = path.extname(filePath).toLowerCase();
  if ([".md", ".txt", ".json", ".yml", ".yaml", ".toml", ".ini", ".cfg"].includes(ext)) {
    return 40;
  }
  if ([".css", ".html", ".svg"].includes(ext)) return 80;
  return MIN_CODING_WRITE_CHARS;
}

type EventFn = (sessionId: string, event: AgentEvent) => void;

export class AgentLoop {
  private chat: ChatEngine;
  private store: Store;
  private mcp: McpManager;
  private browser = new BrowserTooling();
  private onEvent?: EventFn;
  private cancelled = false;
  private pendingConfirm = new Map<
    string,
    {
      resolve: (approved: boolean) => void;
      toolName: string;
      sessionId: string;
      rememberKey: string | null;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();
  /** Remembered approvals keyed by session → approvalRememberKey (path-scoped for writes). */
  private allowBySession = new Map<string, Set<string>>();
  private running = false;
  /** Max wait for UI confirmation before auto-reject (ms). */
  static CONFIRM_TIMEOUT_MS = 120_000;

  constructor(chat: ChatEngine, store: Store, mcp: McpManager) {
    this.chat = chat;
    this.store = store;
    this.mcp = mcp;
  }

  setEventHandler(fn: EventFn): void {
    this.onEvent = fn;
  }

  cancel(): void {
    this.cancelled = true;
    // Interrupt in-flight LLM JSON completion used by the agent loop.
    this.chat.stop();
    // Kill active run_terminal process trees (B7).
    cancelActiveTerminals();
    for (const [id, p] of this.pendingConfirm) {
      if (p.timer) clearTimeout(p.timer);
      p.resolve(false);
      this.pendingConfirm.delete(id);
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  resolveConfirmation(id: string, approved: boolean, remember = false): void {
    const pending = this.pendingConfirm.get(id);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    if (approved && remember && pending.sessionId && pending.rememberKey) {
      this.allowFor(pending.sessionId).add(pending.rememberKey);
    }
    pending.resolve(approved);
    this.pendingConfirm.delete(id);
  }

  private allowFor(sessionId: string): Set<string> {
    let set = this.allowBySession.get(sessionId);
    if (!set) {
      set = new Set();
      this.allowBySession.set(sessionId, set);
    }
    return set;
  }

  /** Drop remembered approvals when a session is deleted. */
  clearSessionAllow(sessionId: string): void {
    this.allowBySession.delete(sessionId);
  }

  private emit(sessionId: string, event: AgentEvent): void {
    this.onEvent?.(sessionId, event);
  }

  private async confirmIfNeeded(
    sessionId: string,
    toolName: string,
    args: Record<string, unknown>,
    settings: AppSettings,
  ): Promise<boolean> {
    const normalized = normalizeToolArgs(toolName, args, settings.projectRoot);
    const risk = riskForTool(toolName, normalized, settings.projectRoot);
    if (risk === "low") return true;
    const rememberKey = approvalRememberKey(
      toolName,
      normalized,
      settings.projectRoot,
    );
    if (rememberKey && this.allowFor(sessionId).has(rememberKey)) return true;
    if (
      !shouldConfirmRisk(
        risk,
        settings.agentRiskMode || "ask",
        normalized,
        settings.projectRoot,
        toolName,
      )
    ) {
      return true;
    }

    let diff: string | undefined;
    try {
      if (toolName === "write_file") {
        diff = previewWriteDiff(
          String(normalized.path || ""),
          String(normalized.content ?? ""),
          settings,
        );
      } else if (toolName === "apply_patch") {
        diff = previewPatchDiff(
          String(normalized.path || ""),
          String(normalized.oldText ?? ""),
          String(normalized.newText ?? ""),
          settings,
        );
      }
    } catch {
      diff = undefined;
    }

    const argPreview = JSON.stringify(normalized);
    const confirmation: AgentConfirmation = {
      id: uuid(),
      toolName,
      summary: `${toolName} ${argPreview.length > 1200 ? argPreview.slice(0, 1200) + "…" : argPreview}`,
      args: normalized,
      risk: risk === "high" ? "high" : "medium",
      createdAt: new Date().toISOString(),
      diff,
    };
    this.emit(sessionId, { type: "confirmation_required", confirmation });
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        const still = this.pendingConfirm.get(confirmation.id);
        if (!still) return;
        this.pendingConfirm.delete(confirmation.id);
        this.emit(sessionId, {
          type: "confirmation_timeout",
          confirmationId: confirmation.id,
          toolName,
        });
        still.resolve(false);
      }, AgentLoop.CONFIRM_TIMEOUT_MS);
      this.pendingConfirm.set(confirmation.id, {
        resolve,
        toolName,
        sessionId,
        rememberKey,
        timer,
      });
    });
  }

  private async execTool(
    name: string,
    args: Record<string, unknown>,
    settings: AppSettings,
  ): Promise<string> {
    const a = normalizeToolArgs(name, args, settings.projectRoot);
    switch (name) {
      case "list_dir":
        return listDir(String(a.path), settings);
      case "read_file":
        return readFileTool(String(a.path), settings);
      case "write_file":
        return writeFileTool(String(a.path), String(a.content ?? ""), settings);
      case "apply_patch":
        return applyPatchTool(
          String(a.path),
          String(a.oldText ?? ""),
          String(a.newText ?? ""),
          settings,
        );
      case "delete_path":
        return deletePathTool(String(a.path), settings);
      case "search":
        return searchFiles(String(a.query ?? args.query), String(a.path), settings);
      case "run_terminal":
        return runTerminal(
          String(a.command ?? a.cmd ?? ""),
          String(a.cwd ?? a.dir ?? a.workdir ?? ""),
          settings,
        );
      case "web_search":
        return webSearch(String(args.query), settings);
      case "browser_navigate":
        return this.browser.navigate(String(args.url));
      case "browser_snapshot":
        return this.browser.snapshot();
      case "browser_click":
        return this.browser.click(String(args.selector));
      case "browser_type":
        return this.browser.type(String(args.selector), String(args.text ?? ""));
      case "finish":
        return String(args.summary ?? "");
      default:
        if (name.startsWith("mcp_")) {
          return this.mcp.callTool(name, args);
        }
        throw new Error(`Неизвестный инструмент: ${name}`);
    }
  }

  async run(
    sessionId: string,
    userContent: string,
    settings: AppSettings,
    params: GenerationParams,
    systemPrompt: string,
  ): Promise<void> {
    if (this.running) throw new Error("Агент уже выполняется");
    this.running = true;
    this.cancelled = false;
    projectContextCache.clear();

    try {
      this.store.addMessage(sessionId, { role: "user", content: userContent });
      const ctxWindow = params.context || 8192;
      const compactTools = ctxWindow < 8192;
      const mcpTools = this.mcp.listTools().map((t) => ({
        name: t.name,
        description: t.description,
      }));
      const extraToolNames = mcpTools.map((t) => t.name);
      const toolBlock = toolsPromptBlock(mcpTools, { compact: compactTools });

      // Cursor-like layered context: tools + rules + retrieval + project map (budgeted).
      const projectCtx = await buildProjectContext({
        settings,
        userQuery: userContent,
        baseSystem: systemPrompt,
        toolBlock,
        contextTokens: ctxWindow,
        // Smaller reserve for tiny ctx so tools+map fit (P1-15).
        reserveTokens: Math.min(
          Math.floor(ctxWindow * (ctxWindow < 8192 ? 0.28 : 0.42)),
          ctxWindow < 8192 ? 1800 : 3500,
        ),
      });
      const semanticErr = getLastSemanticError();
      this.emit(sessionId, {
        type: "thinking",
        text: `Контекст: map=${projectCtx.stats.filesMapped} файлов, retrieved=${projectCtx.stats.filesRetrieved}, ~${projectCtx.stats.usedTokens} tok` +
          (projectCtx.stats.truncatedLayers.length
            ? ` (урезано: ${projectCtx.stats.truncatedLayers.join(",")})`
            : "") +
          (semanticErr ? ` · @codebase: ${semanticErr.slice(0, 160)}` : ""),
      });

      let baseSystem = projectCtx.systemPrompt;
      const session = this.store.listSessions().find((s) => s.id === sessionId);
      const restored = parseWorkingMemory(session?.agentScratchpad);
      const freshGoal = userContent.replace(/\s+/g, " ").trim().slice(0, 400);
      const goalChanged =
        Boolean(restored?.goal) &&
        restored!.goal.toLowerCase() !== freshGoal.toLowerCase() &&
        !freshGoal.toLowerCase().includes(restored!.goal.toLowerCase().slice(0, 80));
      const workingMemory = restored
        ? {
            ...restored,
            goal: freshGoal,
            ...(goalChanged
              ? {
                  plan: [],
                  planFrozen: false,
                  notes: [],
                  lastError: null,
                  lastTool: null,
                  lastResult: null,
                }
              : {}),
          }
        : createWorkingMemory(userContent);
      // Resume: existing plan counts as frozen.
      if (workingMemory.plan.length > 0 && workingMemory.planFrozen !== false) {
        workingMemory.planFrozen = true;
      }
      if (!workingMemory.plan.length) {
        workingMemory.planFrozen = false;
      }

      let transcript: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
        {
          role: "system",
          content: applyWorkingMemoryToSystem(baseSystem, workingMemory),
        },
      ];

      // Limited lookback — full session history (retries/duplicates) blows local ctx.
      const prior = this.store.getMessages(sessionId);
      const recent = prior.slice(-PRIOR_LOOKBACK_MESSAGES);
      let lastUser = "";
      for (const m of recent) {
        if (m.role === "system") continue;
        if (m.role === "tool") {
          transcript.push({
            role: "user",
            content: `Результат инструмента ${m.toolName || "tool"}:\n${m.content.slice(0, TOOL_RESULT_TRANSCRIPT_CHARS)}`,
          });
          continue;
        }
        if (m.role === "user" || m.role === "assistant") {
          if (m.role === "user") {
            const t = m.content.trim();
            if (t && t === lastUser) continue; // drop duplicate user retries
            lastUser = t;
          }
          transcript.push({ role: m.role, content: m.content });
        }
      }
      transcript = condenseTranscript(transcript, {
        keepRecent: 8,
        triggerMessages: 12,
        summaryTokens: Math.min(500, Math.floor(ctxWindow * 0.06)),
        workingMemory,
      });

      let steps: AgentPlanStep[] = goalChanged
        ? []
        : (workingMemory.plan || []).map((p) => ({
            id: p.id,
            title: p.title,
            status: (p.status as AgentPlanStep["status"]) || "pending",
          }));
      if (steps.length && workingMemory.planFrozen) {
        this.emit(sessionId, { type: "plan", steps });
      }
      let planAttempts = 0;
      let toolsUsed = 0;
      let filesWritten = workingMemory.filesTouched?.length
        ? workingMemory.filesTouched.filter((f) =>
            workingMemory.notes.some((n) => n.includes(`wrote ${f}`) || /wrote /.test(n)),
          ).length
        : 0;
      // Count prior writes from notes so resume doesn't re-force from zero incorrectly.
      if (!filesWritten && workingMemory.notes.some((n) => /^wrote /.test(n))) {
        filesWritten = workingMemory.notes.filter((n) => /^wrote /.test(n)).length;
      }
      let substantialWrite =
        filesWritten > 0 &&
        workingMemory.notes.some((n) => /^wrote /.test(n) && !/stub/i.test(n));
      let stubNudgeCount = 0;
      let lastRetrieveAt = 0;
      const wantsFiles = detectCodingTask(userContent);

      const persistScratchpad = () => {
        const cur = this.store.listSessions().find((s) => s.id === sessionId);
        if (!cur) return;
        this.store.updateSession({
          ...cur,
          agentScratchpad: serializeWorkingMemory(workingMemory),
          updatedAt: new Date().toISOString(),
        });
      };

      const refreshRetrieved = async (reason: string) => {
        const root = settings.projectRoot;
        if (!root) return;
        try {
          // Invalidate after writes so next retrieve sees new files.
          if (/write/i.test(reason)) projectContextCache.clear();
          const snippets = await projectContextCache.getRetrieved(
            root,
            workingMemory.goal || userContent,
            {
              maxFiles: 6,
              maxBytesPerFile: 3500,
              maxTotalBytes: 14_000,
              forceSemantic: true,
            },
          );
          const block = formatRetrievedSnippets(snippets);
          if (!block) return;
          let next = baseSystem;
          const cut = next.search(/^# Релевантный код/m);
          if (cut > 0) next = next.slice(0, cut).trimEnd();
          baseSystem = `${next}\n\n${block}`;
          this.emit(sessionId, {
            type: "thinking",
            text: `Контекст обновлён (${reason}): retrieved=${snippets.length} файлов`,
          });
        } catch {
          // non-fatal
        }
      };

      const syncSystem = () => {
        updatePlanMemory(workingMemory, steps);
        if (transcript[0]?.role === "system") {
          transcript[0] = {
            role: "system",
            content: applyWorkingMemoryToSystem(baseSystem, workingMemory),
          };
        }
      };

      let lastPhaseKind: "plan" | "exec" | null = null;
      let repairAttempts = 0;

      for (let i = 0; i < settings.agentMaxSteps; i++) {
        if (this.cancelled) {
          this.emit(sessionId, { type: "cancelled" });
          return;
        }
        const planFrozen = Boolean(workingMemory.planFrozen) && steps.length > 0;
        const curPlan = currentPlanStep(steps);
        // Match plan step ids ("1","2",…) so ChatPage checklist updates.
        const stepId = planFrozen && curPlan ? curPlan.id : `p${i + 1}`;
        this.emit(sessionId, { type: "step_start", stepId });
        this.emit(sessionId, {
          type: "thinking",
          text: planFrozen
            ? `Шаг ${i + 1}/${settings.agentMaxSteps}: исполнение плана…`
            : `Шаг ${i + 1}/${settings.agentMaxSteps}: составление плана…`,
        });

        // Inject phase instruction once per phase (not every tool turn).
        syncSystem();
        const phaseKind = planFrozen ? "exec" : "plan";
        if (lastPhaseKind !== phaseKind) {
          const phaseHint = planFrozen
            ? executePhaseHint(curPlan, steps)
            : planPhaseInstruction(wantsFiles);
          transcript.push({ role: "user", content: phaseHint });
          lastPhaseKind = phaseKind;
        }

        let raw: string;
        try {
          // Coding writes need a large completion budget (JSON + full file content).
          // Plan-only phase can use a smaller budget.
          const ctx = params.context || 8192;
          const hardCap = Math.max(
            1024,
            Math.min(planFrozen ? 6144 : 2048, ctx - 512),
          );
          const want = !planFrozen
            ? 1024
            : wantsFiles
              ? Math.max(params.maxTokens || 0, 4096)
              : Math.max(params.maxTokens || 0, 2048);
          const maxTokens = Math.min(
            want,
            Math.max(512, Math.floor(ctx * (!planFrozen ? 0.2 : wantsFiles ? 0.5 : 0.4))),
            hardCap,
          );
          const loadedId = this.chat.getRuntime().getStatus().loadedModelId || "";
          const family = detectModelFamily(loadedId);
          const tuning = agentTuningForFamily(family);
          const callParams = {
            ...params,
            maxTokens,
            temperature: Math.min(params.temperature, tuning.temperatureCap),
            minP: Math.max(params.minP ?? 0, tuning.minP),
          };
          syncSystem();
          const beforeLen = transcript.length;
          // Fold old tool turns into an extractive summary as the run grows.
          transcript = condenseTranscript(transcript, {
            keepRecent: 8,
            triggerMessages: 12,
            summaryTokens: Math.min(500, Math.floor(ctx * 0.06)),
            workingMemory,
          });
          if (transcript.length < beforeLen) {
            workingMemory.notes.push("history condensed");
            if (workingMemory.notes.length > 12) {
              workingMemory.notes = workingMemory.notes.slice(-12);
            }
            this.emit(sessionId, {
              type: "thinking",
              text: `Сжатие истории шагов (цель и план сохранены в Working memory)`,
            });
          }
          syncSystem();
          let packed = fitMessagesToContext(transcript, ctx, maxTokens);
          const usedTok = estimateMessagesTokens(packed);
          this.emit(sessionId, {
            type: "thinking",
            text: `Шаг ${i + 1}/${settings.agentMaxSteps}: контекст ~${usedTok}/${ctx} tok · жду модель…`,
          });
          try {
            raw = await this.chat.completeJson(packed, callParams, sessionId, {
              extraToolNames,
            });
          } catch (err) {
            if (this.cancelled) throw err;
            if (isLlmTruncatedError(err)) {
              this.emit(sessionId, {
                type: "thinking",
                text: `Ответ обрезан по max_tokens — прошу модель разбить код на несколько write_file`,
              });
              transcript.push({
                role: "user",
                content:
                  "Предыдущий ответ обрезан (finish_reason=length). НЕ пытайся уместить всю игру в один write_file. " +
                  "Сделай несколько коротких шагов: сначала минимальный запускаемый файл (~80–150 строк), " +
                  "затем отдельные write_file для модулей (pieces, board, ui). thought короткий. Верни один tool JSON.",
              });
              continue;
            }
            if (!isContextOverflowError(err)) throw err;
            // Emergency: keep system+working memory + summary of dropped + recent tail.
            transcript = emergencyShrinkTranscript(transcript, 4, (old) =>
              summarizeTranscript(
                old,
                Math.min(400, Math.floor(ctx * 0.05)),
                workingMemory,
              ),
            );
            workingMemory.notes.push("emergency context shrink");
            persistScratchpad();
            syncSystem();
            packed = fitMessagesToContext(transcript, ctx, maxTokens);
            this.emit(sessionId, {
              type: "thinking",
              text: `Шаг ${i + 1}: контекст переполнен — сжимаю историю, цель и план сохранены… (~${estimateMessagesTokens(packed)}/${ctx} tok)`,
            });
            raw = await this.chat.completeJson(packed, callParams, sessionId, {
              extraToolNames,
            });
          }
        } catch (err) {
          if (this.cancelled || (err instanceof Error && /отмен/i.test(err.message))) {
            this.emit(sessionId, { type: "cancelled" });
            return;
          }
          if (isLlmTruncatedError(err)) {
            this.emit(sessionId, {
              type: "thinking",
              text: `Обрезка ответа — продолжаю со следующим шагом (меньше кода за раз)`,
            });
            transcript.push({
              role: "user",
              content:
                "Ответ снова обрезан. Пиши МЕНЬШЕ за шаг: один небольшой write_file (один модуль). Без длинного thought.",
            });
            continue;
          }
          throw err;
        }
        if (this.cancelled) {
          this.emit(sessionId, { type: "cancelled" });
          return;
        }

        const parsed = parseAgentAction(raw, planFrozen ? "execute" : "plan");
        if (!parsed) {
          repairAttempts += 1;
          const looksTruncated =
            /["']\s*$/.test(raw.trim()) ||
            /,\s*$/.test(raw.trim()) ||
            (raw.includes("{") && !raw.includes("}")) ||
            raw.length > 1500;
          transcript.push({ role: "assistant", content: raw.slice(0, 4000) });
          const loadedId = this.chat.getRuntime().getStatus().loadedModelId || "";
          const familyNudge = agentTuningForFamily(detectModelFamily(loadedId)).jsonNudge;
          const repair =
            repairAttempts <= 2
              ? looksTruncated
                ? `Ответ обрезан. Верни ТОЛЬКО JSON: {"thought":"…","tool":{"name":"write_file","args":{…}}|null,"final":null}. Один короткий write_file.\n${familyNudge}`
                : `Невалидный ответ. ${familyNudge}`
              : looksTruncated
                ? "Снова обрезка. Ещё короче: thought 1 фраза, один tool, без final."
                : `Снова не JSON. ${familyNudge}`;
          transcript.push({ role: "user", content: repair });
          continue;
        }
        repairAttempts = 0;

        if (parsed.thought) {
          this.emit(sessionId, { type: "thinking", text: parsed.thought });
        }

        // ——— Plan phase: freeze checklist, do not execute tools on this turn ———
        if (!planFrozen) {
          planAttempts += 1;
          const normalized = normalizePlanDraft(parsed.plan, wantsFiles);
          if (normalized) {
            steps = normalized;
            workingMemory.planFrozen = true;
            updatePlanMemory(workingMemory, steps);
            persistScratchpad();
            syncSystem();
            this.emit(sessionId, { type: "plan", steps });
            this.emit(sessionId, {
              type: "step_done",
              stepId,
              detail: `План: ${steps.length} шагов`,
            });
            this.emit(sessionId, {
              type: "thinking",
              text: `План зафиксирован (${steps.length} шагов). Перехожу к исполнению.`,
            });
            transcript.push({ role: "assistant", content: JSON.stringify(parsed) });
            transcript.push({
              role: "user",
              content: executePhaseHint(currentPlanStep(steps), steps),
            });
            continue;
          }
          if (planAttempts >= PLAN_PHASE_MAX_ATTEMPTS) {
            steps = defaultPlanForTask(wantsFiles);
            workingMemory.planFrozen = true;
            updatePlanMemory(workingMemory, steps);
            persistScratchpad();
            syncSystem();
            this.emit(sessionId, { type: "plan", steps });
            this.emit(sessionId, {
              type: "step_done",
              stepId,
              detail: "План по шаблону",
            });
            this.emit(sessionId, {
              type: "thinking",
              text: "Модель не дала план — использую шаблон и начинаю исполнение.",
            });
            transcript.push({ role: "assistant", content: JSON.stringify(parsed) });
            transcript.push({
              role: "user",
              content: executePhaseHint(currentPlanStep(steps), steps),
            });
            continue;
          }
          transcript.push({ role: "assistant", content: JSON.stringify(parsed) });
          transcript.push({
            role: "user",
            content:
              planPhaseInstruction(wantsFiles) +
              "\nПлан обязателен: массив plan из 3–7 пунктов. tool и final сейчас запрещены.",
          });
          this.emit(sessionId, {
            type: "step_done",
            stepId,
            detail: "Жду план",
          });
          continue;
        }

        // Frozen: ignore structural plan rewrites from the model.
        if (parsed.plan?.length) {
          // Keep titles/ids; statuses only advanced by the runtime after tools.
        }

        if (parsed.final && !parsed.tool) {
          // Coding: list_dir/read alone must not unlock final (seen in Tetris sessions).
          const noFileYet = wantsFiles && filesWritten === 0;
          const stubOnly =
            wantsFiles &&
            filesWritten > 0 &&
            !substantialWrite &&
            stubNudgeCount < 2;
          const pendingLeft = steps.some((s) => s.status === "pending");
          const current = currentPlanStep(steps);
          const currentIsFinalish =
            current &&
            /итог|final|finish|отчет|отчёт|резюме/i.test(current.title);
          // Keep forcing writes even on the last step when no files exist yet.
          const mustWork =
            noFileYet ||
            (i < settings.agentMaxSteps - 1 &&
              (stubOnly ||
                (!wantsFiles && toolsUsed === 0 && steps.length > 0) ||
                (pendingLeft && !currentIsFinalish && toolsUsed === 0)));
          if (mustWork) {
            if (stubOnly) stubNudgeCount += 1;
            transcript.push({ role: "assistant", content: JSON.stringify(parsed) });
            transcript.push({
              role: "user",
              content: wantsFiles
                ? filesWritten === 0
                  ? "Рано для final. Сначала создай файлы через write_file (полный код в args.content). list_dir/read_file не считаются выполнением. final только после записи рабочих файлов."
                  : `Рано для final: запись похожа на stub. Допиши полный код через write_file или apply_patch (цель ≥${MIN_CODING_WRITE_CHARS} символов на ключевой файл), затем final.`
                : "Рано для final. Сначала выполни текущий пункт плана инструментом.",
            });
            continue;
          }
          const marked = skipRemainingPlan(steps);
          if (marked.length) {
            steps = marked;
            updatePlanMemory(workingMemory, steps);
            persistScratchpad();
            this.emit(sessionId, { type: "plan", steps });
          }
          const msg = this.store.addMessage(sessionId, {
            role: "assistant",
            content: parsed.final,
            thinking: parsed.thought,
          });
          this.emit(sessionId, { type: "stream", text: parsed.final });
          this.emit(sessionId, { type: "done", messageId: msg.id });
          return;
        }

        if (!parsed.tool?.name) {
          transcript.push({ role: "assistant", content: JSON.stringify(parsed) });
          transcript.push({
            role: "user",
            content: wantsFiles
              ? "Нужен tool (write_file) или final. Для кода сначала write_file."
              : "Нужен tool или final. Продолжай.",
          });
          continue;
        }

        const toolName = parsed.tool.name;
        const coerced = coerceToolArgs(toolName, parsed.tool.args || {});
        const argCheck = validateToolArgs(toolName, coerced, extraToolNames);
        if (!argCheck.ok) {
          transcript.push({ role: "assistant", content: JSON.stringify(parsed) });
          transcript.push({
            role: "user",
            content: `${argCheck.error}. Верни JSON с полными tool.args.`,
          });
          this.emit(sessionId, {
            type: "step_done",
            stepId,
            detail: argCheck.error,
          });
          continue;
        }
        const args = argCheck.args;
        parsed.tool = { name: toolName, args };
        const callId = uuid();
        this.emit(sessionId, { type: "tool_call", name: toolName, args, callId });

        if (toolName === "finish") {
          const blockFinishNoFile = wantsFiles && filesWritten === 0;
          const blockFinishStub =
            wantsFiles &&
            filesWritten > 0 &&
            !substantialWrite &&
            stubNudgeCount < 2 &&
            i < settings.agentMaxSteps - 1;
          if (blockFinishNoFile || blockFinishStub) {
            if (blockFinishStub) stubNudgeCount += 1;
            const deny = blockFinishNoFile
              ? "finish отклонён: файлы ещё не записаны. Вызови write_file с полным кодом."
              : "finish отклонён: код ещё stub. Допиши файлы (write_file/apply_patch), затем finish.";
            this.emit(sessionId, { type: "tool_result", callId, result: deny, isError: true });
            this.emit(sessionId, { type: "step_done", stepId, detail: deny });
            transcript.push({ role: "assistant", content: JSON.stringify(parsed) });
            transcript.push({ role: "user", content: deny });
            continue;
          }
          const summary = String(args.summary || parsed.final || "Готово");
          if (steps.length) {
            steps = skipRemainingPlan(steps);
            updatePlanMemory(workingMemory, steps);
            persistScratchpad();
            this.emit(sessionId, { type: "plan", steps });
          }
          const msg = this.store.addMessage(sessionId, {
            role: "assistant",
            content: summary,
            thinking: parsed.thought,
          });
          this.emit(sessionId, {
            type: "tool_result",
            callId,
            result: summary,
          });
          this.emit(sessionId, { type: "stream", text: summary });
          this.emit(sessionId, { type: "done", messageId: msg.id });
          return;
        }

        const approved = await this.confirmIfNeeded(sessionId, toolName, args, settings);
        if (this.cancelled) {
          this.emit(sessionId, { type: "cancelled" });
          return;
        }
        if (!approved) {
          const deny = "Пользователь отклонил действие";
          this.emit(sessionId, { type: "tool_result", callId, result: deny, isError: true });
          this.emit(sessionId, { type: "step_done", stepId, detail: deny });
          transcript.push({ role: "assistant", content: JSON.stringify(parsed) });
          transcript.push({ role: "user", content: `Результат инструмента ${toolName}: ${deny}` });
          continue;
        }

        try {
          const normalizedArgs = normalizeToolArgs(toolName, args, settings.projectRoot);
          const result = await this.execTool(toolName, args, settings);
          toolsUsed += 1;
          if (FILE_MUTATION_TOOLS.has(toolName)) {
            filesWritten += 1;
            const targetPath = String(normalizedArgs.path ?? args.path ?? "");
            if (toolName === "write_file") {
              const contentLen = String(normalizedArgs.content ?? "").length;
              if (contentLen >= minWriteCharsForPath(targetPath)) {
                substantialWrite = true;
              }
            } else {
              // apply_patch: small diffs are valid if they replace real code.
              const newLen = String(normalizedArgs.newText ?? "").length;
              const oldLen = String(normalizedArgs.oldText ?? "").length;
              if (newLen >= 1 && oldLen >= 1) {
                substantialWrite = true;
              }
            }
            if (settings.projectRoot && targetPath) {
              void invalidateIndexPaths(settings.projectRoot, [targetPath]).catch(() => undefined);
            }
          }
          if (steps.length && PLAN_ADVANCING_TOOLS.has(toolName)) {
            steps = markCurrentPlanDone(steps, toolName);
            this.emit(sessionId, { type: "plan", steps });
          }
          rememberToolSuccess(workingMemory, toolName, normalizedArgs, result);
          updatePlanMemory(workingMemory, steps);
          persistScratchpad();
          if (
            FILE_MUTATION_TOOLS.has(toolName) ||
            (i - lastRetrieveAt >= 3 && toolsUsed > 0)
          ) {
            lastRetrieveAt = i;
            await refreshRetrieved(
              FILE_MUTATION_TOOLS.has(toolName) ? `после ${toolName}` : "периодически",
            );
            syncSystem();
          }
          this.store.addMessage(sessionId, {
            role: "tool",
            content: result,
            toolCallId: callId,
            toolName,
          });
          this.emit(sessionId, { type: "tool_result", callId, result });
          this.emit(sessionId, {
            type: "step_done",
            stepId,
            detail: `${toolName} ok`,
          });
          let followUp = `Результат инструмента ${toolName}:\n${result.slice(0, TOOL_RESULT_TRANSCRIPT_CHARS)}`;
          if (
            wantsFiles &&
            toolName === "write_file" &&
            String(normalizedArgs.content ?? "").length <
              minWriteCharsForPath(String(normalizedArgs.path ?? args.path ?? ""))
          ) {
            followUp += `\n\nЗамечание: файл получился коротким (stub). Продолжи: допиши полную реализацию через write_file/apply_patch. Не вызывай final, пока программа не работает.`;
          }
          transcript.push({ role: "assistant", content: JSON.stringify(parsed) });
          transcript.push({
            role: "user",
            content: followUp,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          rememberToolError(workingMemory, toolName, message);
          if (steps.length) {
            steps = markCurrentPlanFailed(steps, message.slice(0, 120));
            this.emit(sessionId, { type: "plan", steps });
          }
          persistScratchpad();
          this.emit(sessionId, {
            type: "tool_result",
            callId,
            result: message,
            isError: true,
          });
          this.emit(sessionId, { type: "step_done", stepId, detail: message });
          transcript.push({ role: "assistant", content: JSON.stringify(parsed) });
          transcript.push({
            role: "user",
            content: `Ошибка инструмента ${toolName}: ${message}`,
          });
        }
      }

      const limitMsg =
        wantsFiles && filesWritten === 0
          ? "Достигнут лимит шагов агента, файлы так и не были записаны. Увеличьте лимит шагов или повторите с @agent и явной просьбой write_file."
          : "Достигнут лимит шагов агента. Уточните задачу или увеличьте лимит в настройках.";
      const msg = this.store.addMessage(sessionId, {
        role: "assistant",
        content: limitMsg,
      });
      this.emit(sessionId, {
        type: "error",
        message: `incomplete: ${limitMsg}`,
      });
      this.emit(sessionId, { type: "done", messageId: msg.id });
    } catch (err) {
      this.emit(sessionId, {
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.running = false;
    }
  }

  async dispose(): Promise<void> {
    await this.browser.close();
  }
}

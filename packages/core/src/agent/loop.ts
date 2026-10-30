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
import { runTerminal } from "../tools/terminal.js";
import { previewPatchDiff, previewWriteDiff } from "../tools/diff.js";
import {
  approvalRememberKey,
  resolveAgentPath,
  riskForTool,
  shouldConfirmRisk,
} from "../tools/sandbox.js";
import { webSearch } from "../tools/websearch.js";
import {
  fitMessagesToContext,
  isContextOverflowError,
} from "../chat/contextBudget.js";
import { buildProjectContext } from "../context/packer.js";
import { condenseTranscript } from "../context/summarize.js";
import { toolsPromptBlock } from "./toolsCatalog.js";

const TOOL_RESULT_TRANSCRIPT_CHARS = 2_500;
const PRIOR_LOOKBACK_MESSAGES = 10;

/** Alias common model mistakes before path normalization. */
function coerceToolArgs(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...args };
  if ((next.path == null || String(next.path).trim() === "") && next.file != null) {
    next.path = next.file;
  }
  if (toolName === "write_file" && (next.content == null || next.content === "")) {
    if (typeof next.text === "string") next.content = next.text;
    else if (typeof next.code === "string") next.content = next.code;
    else if (typeof next.body === "string") next.content = next.body;
  }
  if (toolName === "apply_patch") {
    if (next.oldText == null && typeof next.old === "string") next.oldText = next.old;
    if (next.newText == null && typeof next.new === "string") next.newText = next.new;
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

interface ParsedAction {
  thought?: string;
  plan?: Array<{ id: string; title: string }>;
  tool?: { name: string; args?: Record<string, unknown> } | null;
  final?: string | null;
}

function extractBalancedObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]!;
    if (inStr) {
      if (esc) {
        esc = false;
      } else if (ch === "\\") {
        esc = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

function extractJson(text: string): ParsedAction | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fence?.[1] || text;
  const candidates = [extractBalancedObject(raw), (() => {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    return raw.slice(start, end + 1);
  })()].filter(Boolean) as string[];
  for (const piece of candidates) {
    try {
      return JSON.parse(piece) as ParsedAction;
    } catch {
      // try next
    }
  }
  return null;
}

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
    }
  >();
  /** Remembered approvals keyed by session → approvalRememberKey (path-scoped for writes). */
  private allowBySession = new Map<string, Set<string>>();
  private running = false;

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
    for (const [id, p] of this.pendingConfirm) {
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
      this.pendingConfirm.set(confirmation.id, {
        resolve,
        toolName,
        sessionId,
        rememberKey,
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

    try {
      this.store.addMessage(sessionId, { role: "user", content: userContent });
      const ctxWindow = params.context || 8192;
      const compactTools = ctxWindow < 8192;
      const toolBlock = toolsPromptBlock(
        this.mcp.listTools().map((t) => ({ name: t.name, description: t.description })),
        { compact: compactTools },
      );

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
      this.emit(sessionId, {
        type: "thinking",
        text: `Контекст: map=${projectCtx.stats.filesMapped} файлов, retrieved=${projectCtx.stats.filesRetrieved}, ~${projectCtx.stats.usedTokens} tok` +
          (projectCtx.stats.truncatedLayers.length
            ? ` (урезано: ${projectCtx.stats.truncatedLayers.join(",")})`
            : ""),
      });

      let transcript: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
        {
          role: "system",
          content: projectCtx.systemPrompt,
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
        summaryTokens: Math.min(400, Math.floor(ctxWindow * 0.05)),
      });

      let steps: AgentPlanStep[] = [];
      let toolsUsed = 0;
      let filesWritten = 0;
      let substantialWrite = false;
      let stubNudgeCount = 0;
      const wantsFiles = /файл|код|игр[ауы]|напиш|создай|реализ|скрипт|программ|python|tetris|html|react/i.test(
        userContent,
      );

      for (let i = 0; i < settings.agentMaxSteps; i++) {
        if (this.cancelled) {
          this.emit(sessionId, { type: "cancelled" });
          return;
        }
        const stepId = `step-${i + 1}`;
        this.emit(sessionId, { type: "step_start", stepId });

        let raw: string;
        try {
          // Cap vs context — leave headroom; never request completion that can't fit.
          const ctx = params.context || 8192;
          const want = wantsFiles
            ? Math.max(params.maxTokens || 0, 2048)
            : Math.max(params.maxTokens || 0, 1536);
          const maxTokens = Math.min(want, Math.max(512, Math.floor(ctx * 0.35)), 3072);
          const callParams = {
            ...params,
            maxTokens,
            temperature: Math.min(params.temperature, 0.4),
          };
          // Fold old tool turns into an extractive summary as the run grows.
          transcript = condenseTranscript(transcript, {
            keepRecent: 8,
            triggerMessages: 12,
            summaryTokens: Math.min(400, Math.floor(ctx * 0.05)),
          });
          let packed = fitMessagesToContext(transcript, ctx, maxTokens);
          try {
            raw = await this.chat.completeJson(packed, callParams);
          } catch (err) {
            if (!isContextOverflowError(err) || this.cancelled) throw err;
            // Emergency shrink: drop oldest non-system turns and retry once.
            const system = transcript[0];
            const tail = transcript.slice(Math.max(1, transcript.length - 4));
            transcript = system ? [system, ...tail] : [...tail];
            packed = fitMessagesToContext(transcript, ctx, maxTokens);
            raw = await this.chat.completeJson(packed, callParams);
          }
        } catch (err) {
          if (this.cancelled || (err instanceof Error && /отмен/i.test(err.message))) {
            this.emit(sessionId, { type: "cancelled" });
            return;
          }
          throw err;
        }
        if (this.cancelled) {
          this.emit(sessionId, { type: "cancelled" });
          return;
        }

        const parsed = extractJson(raw);
        if (!parsed) {
          transcript.push({ role: "assistant", content: raw });
          transcript.push({
            role: "user",
            content: "Ответ не JSON. Верни строго JSON по схеме.",
          });
          continue;
        }

        if (parsed.thought) {
          this.emit(sessionId, { type: "thinking", text: parsed.thought });
        }

        if (parsed.plan?.length) {
          steps = parsed.plan.map((p) => ({
            id: p.id,
            title: p.title,
            status: "pending" as const,
          }));
          this.emit(sessionId, { type: "plan", steps });
        }

        if (parsed.final && !parsed.tool) {
          // Coding: list_dir/read alone must not unlock final (seen in Tetris sessions).
          const noFileYet = wantsFiles && filesWritten === 0;
          const stubOnly =
            wantsFiles &&
            filesWritten > 0 &&
            !substantialWrite &&
            stubNudgeCount < 2;
          const mustWork =
            i < settings.agentMaxSteps - 1 &&
            (noFileYet || stubOnly || (!wantsFiles && toolsUsed === 0 && steps.length > 0));
          if (mustWork) {
            if (stubOnly) stubNudgeCount += 1;
            transcript.push({ role: "assistant", content: JSON.stringify(parsed) });
            transcript.push({
              role: "user",
              content: wantsFiles
                ? filesWritten === 0
                  ? "Рано для final. Сначала создай файлы через write_file (полный код в args.content). list_dir/read_file не считаются выполнением. final только после записи рабочих файлов."
                  : `Рано для final: запись похожа на stub. Допиши полный код через write_file или apply_patch (цель ≥${MIN_CODING_WRITE_CHARS} символов на ключевой файл), затем final.`
                : "Рано для final. Сначала выполни план инструментами.",
            });
            continue;
          }
          const marked = steps.map((s) =>
            s.status === "pending" ? { ...s, status: "skipped" as const } : s,
          );
          if (marked.length) {
            steps = marked;
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
        const args = parsed.tool.args || {};
        const callId = uuid();
        this.emit(sessionId, { type: "tool_call", name: toolName, args, callId });

        if (toolName === "finish") {
          const blockFinishNoFile =
            wantsFiles && filesWritten === 0 && i < settings.agentMaxSteps - 1;
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
            const contentLen =
              toolName === "write_file"
                ? String(normalizedArgs.content ?? "").length
                : String(normalizedArgs.newText ?? "").length;
            const targetPath = String(normalizedArgs.path ?? args.path ?? "");
            if (contentLen >= minWriteCharsForPath(targetPath)) {
              substantialWrite = true;
            }
          }
          if (steps.length) {
            const idx = steps.findIndex((s) => s.status === "pending");
            if (idx >= 0) {
              steps = steps.map((s, j) =>
                j === idx ? { ...s, status: "done" as const, detail: toolName } : s,
              );
              this.emit(sessionId, { type: "plan", steps });
            }
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

      const msg = this.store.addMessage(sessionId, {
        role: "assistant",
        content: "Достигнут лимит шагов агента. Уточните задачу или увеличьте лимит в настройках.",
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

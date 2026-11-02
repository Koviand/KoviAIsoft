import path from "node:path";
import { v4 as uuid } from "uuid";
import type {
  AgentEvent,
  AgentPlanStep,
  AppSettings,
  ChatAttachment,
  GenerationParams,
} from "@kovi/shared";
import type { ChatEngine } from "../chat/engine.js";
import type { Store } from "../db/store.js";
import type { McpManager } from "../mcp/manager.js";
import { BrowserTooling } from "../tools/browser.js";
import { cancelActiveTerminals } from "../tools/terminal.js";
import { resolveAgentPath } from "../tools/sandbox.js";
import { buildToolConfirmation, evaluateToolConfirmNeed } from "./confirmGate.js";
import { execAgentTool } from "./toolExec.js";
import { clampCompletionTokens } from "../chat/completionBudget.js";
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
import { buildIncompleteEvent } from "./phases/budgetExhaust.js";
import { runBatchTools } from "./phases/runBatchTools.js";
import {
  agentTuningForFamily,
  detectModelFamily,
  looksLikeSmallOrUnknownModel,
  modelIdentityForTuning,
  preferredConstraintMode,
} from "../models/modelFamily.js";
import {
  currentPlanStep,
  defaultPlanForTask,
  executePhaseHint,
  isExploreTool,
  isSoftResumeGoal,
  markCurrentPlanDone,
  normalizePlanDraft,
  PLAN_PHASE_MAX_ATTEMPTS,
  planPhaseInstruction,
  resolveAgentPhase,
  shouldAdvancePlanOnTool,
  skipCurrentPlanStep,
  skipRemainingPlan,
  stepKindOf,
} from "./planner.js";
import {
  parseAgentAction,
  PLAN_ADVANCING_TOOLS,
  validateToolArgs,
} from "./parseAction.js";
import { toolsPromptBlock } from "./toolsCatalog.js";
import {
  AGENT_AUTO_EXTEND_BATCH,
  AGENT_AUTO_EXTEND_MAX,
  AGENT_IDENTICAL_TOOL_MAX,
  AGENT_NON_ADVANCING_HARD_STOP,
  AGENT_NON_ADVANCING_MAX,
  AGENT_REFUSAL_HARD_STOP,
  AGENT_REPAIR_HARD_STOP,
  AGENT_REPAIR_MAX,
  AGENT_STEPS_SAFETY_CAP,
  AGENT_TRUNCATION_MAX,
  agentHasPendingWork,
  clampAgentMaxSteps,
  inFinishWindow,
  isModelRefusalText,
  toolFingerprint,
} from "./finishPolicy.js";
import {
  applyWorkingMemoryToSystem,
  clearPlanAfterCompletion,
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
      resolve: (result: "approved" | "rejected" | "timeout") => void;
      toolName: string;
      sessionId: string;
      rememberKey: string | null;
      timer?: ReturnType<typeof setTimeout>;
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
    // Kill active run_terminal process trees (B7).
    cancelActiveTerminals();
    for (const [id, p] of this.pendingConfirm) {
      if (p.timer) clearTimeout(p.timer);
      p.resolve("rejected");
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
    pending.resolve(approved ? "approved" : "rejected");
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
    callId?: string,
  ): Promise<"approved" | "rejected" | "timeout"> {
    const normalized = normalizeToolArgs(toolName, args, settings.projectRoot);
    const { needsConfirm, risk, rememberKey } = evaluateToolConfirmNeed(
      toolName,
      normalized,
      settings,
      this.allowFor(sessionId),
    );
    if (!needsConfirm) return "approved";

    if (callId) {
      this.emit(sessionId, {
        type: "tool_call",
        name: toolName,
        args: normalized,
        callId,
        status: "awaiting_confirm",
      });
    }

    const confirmation = buildToolConfirmation({
      id: uuid(),
      toolName,
      normalizedArgs: normalized,
      risk,
      settings,
    });
    this.emit(sessionId, { type: "confirmation_required", confirmation });
    const rawTimeout =
      typeof settings.agentConfirmTimeoutSec === "number"
        ? settings.agentConfirmTimeoutSec
        : 120;
    // ≤0 used to mean "wait forever" and hung the UI — treat as 180s (Cursor-like).
    const timeoutSec = rawTimeout <= 0 ? 180 : rawTimeout;
    const timeoutMs = Math.max(5_000, Math.min(600_000, Math.floor(timeoutSec) * 1000));
    this.emit(sessionId, {
      type: "thinking",
      text: `Ждёт подтверждения «${toolName}» (до ${Math.round(timeoutMs / 1000)} с)…`,
    });
    return new Promise<"approved" | "rejected" | "timeout">((resolve) => {
      const timer = setTimeout(() => {
        const still = this.pendingConfirm.get(confirmation.id);
        if (!still) return;
        this.pendingConfirm.delete(confirmation.id);
        this.emit(sessionId, {
          type: "confirmation_timeout",
          confirmationId: confirmation.id,
          toolName,
          timeoutSec: Math.round(timeoutMs / 1000),
        });
        still.resolve("timeout");
      }, timeoutMs);
      this.pendingConfirm.set(confirmation.id, {
        resolve,
        toolName,
        sessionId,
        rememberKey,
        timer,
      });
    });
  }

  private checkpointRunId: string | null = null;

  private async execTool(
    name: string,
    args: Record<string, unknown>,
    settings: AppSettings,
  ): Promise<string> {
    return execAgentTool({
      name,
      args,
      settings,
      normalize: normalizeToolArgs,
      browser: this.browser,
      mcp: this.mcp,
      checkpointRunId: this.checkpointRunId || undefined,
    });
  }

  async run(
    sessionId: string,
    userContent: string,
    settings: AppSettings,
    params: GenerationParams,
    systemPrompt: string,
    attachments?: ChatAttachment[],
  ): Promise<void> {
    if (this.running) throw new Error("Агент уже выполняется");
    this.running = true;
    this.cancelled = false;
    this.checkpointRunId = `${sessionId.slice(0, 8)}-${Date.now().toString(36)}`;
    projectContextCache.clear();

    try {
      this.store.addMessage(sessionId, {
        role: "user",
        content: userContent,
        attachments: attachments?.length ? attachments : undefined,
      });
      const ctxWindow = params.context || 8192;
      const compactTools = ctxWindow < 8192;
      const mcpTools = this.mcp.listTools().map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
      const extraToolNames = mcpTools.map((t) => t.name);
      const mcpSchemas: Record<string, unknown> = {};
      for (const t of mcpTools) {
        if (t.inputSchema != null) mcpSchemas[t.name] = t.inputSchema;
      }
      const toolBlock = toolsPromptBlock(mcpTools, { compact: compactTools });

      const session = this.store.listSessions().find((s) => s.id === sessionId);
      const restored = parseWorkingMemory(session?.agentScratchpad);
      const freshGoal = userContent.replace(/\s+/g, " ").trim().slice(0, 400);
      const unfinishedFrozen =
        Boolean(restored?.planFrozen) &&
        Array.isArray(restored?.plan) &&
        restored!.plan.some(
          (p) => p.status === "pending" || p.status === "running",
        );
      const softResume =
        Boolean(restored?.goal) &&
        isSoftResumeGoal(freshGoal, restored!.goal, {
          hasUnfinishedFrozenPlan: unfinishedFrozen,
        });
      const goalChanged =
        Boolean(restored?.goal) &&
        restored!.goal.toLowerCase() !== freshGoal.toLowerCase() &&
        !softResume;
      const effectiveGoal =
        softResume && restored?.goal ? restored.goal : freshGoal;
      const contextQuery = softResume && restored?.goal ? restored.goal : userContent;

      // Cursor-like layered context: tools + rules + retrieval + project map (budgeted).
      const projectCtx = await buildProjectContext({
        settings,
        userQuery: contextQuery,
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
      const workingMemory = restored
        ? {
            ...restored,
            goal: effectiveGoal,
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
            const prev = transcript[transcript.length - 1];
            // Only collapse consecutive identical user turns (not resume after assistant).
            if (t && prev?.role === "user" && prev.content.trim() === t) continue;
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
      const wantsFiles = detectCodingTask(effectiveGoal || userContent);

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
          // Invalidate after file mutations so next retrieve sees new files.
          if (/write|patch|mutat/i.test(reason)) projectContextCache.clear();
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

      let lastPhaseKind: "plan" | "execute" | "finish_only" | null = null;
      let repairAttempts = 0;
      let truncationStreak = 0;
      let identicalToolStreak = 0;
      let lastToolFp: string | null = null;
      let identicalNudgeSent = false;
      /** Wrong tools on run/verify steps before soft-skip. */
      let kindMismatchStreak = 0;
      let nonAdvancingStreak = 0;
      let refusalStreak = 0;
      const userStepsPref =
        typeof settings.agentMaxSteps === "number" ? settings.agentMaxSteps : 0;
      const showStepCap = userStepsPref > 0;
      let stepBudget = clampAgentMaxSteps(settings.agentMaxSteps);
      let autoExtends = 0;
      const autoExtendEnabled = settings.agentAutoExtendEnabled !== false;
      const autoExtendMax = Math.max(
        0,
        Math.min(
          AGENT_AUTO_EXTEND_MAX,
          Number.isFinite(settings.agentAutoExtendMax)
            ? Math.floor(settings.agentAutoExtendMax)
            : 10,
        ),
      );
      const maxRunMs =
        settings.agentMaxRunMinutes > 0
          ? settings.agentMaxRunMinutes * 60_000
          : 0;
      const runStartedAt = Date.now();
      let stopReason: "budget" | "no_progress" | "time_limit" | null = null;

      // i advances every iteration; repair/truncation/plan-wait paths unbill (i--) so they
      // do not burn the step budget.
      for (let i = 0; ; i++) {
        if (this.cancelled) {
          this.emit(sessionId, { type: "cancelled" });
          return;
        }
        const unbillStep = () => {
          i = Math.max(-1, i - 1);
        };
        if (maxRunMs > 0 && Date.now() - runStartedAt >= maxRunMs) {
          this.emit(sessionId, {
            type: "thinking",
            text: `Лимит времени агента (${settings.agentMaxRunMinutes} мин) — останавливаюсь.`,
          });
          stopReason = "time_limit";
          break;
        }
        const pendingWork = agentHasPendingWork({
          steps,
          wantsFiles,
          filesWritten,
          substantialWrite,
        });
        // Soft limit: keep going while plan/coding work remains (up to safety cap).
        if (i >= stepBudget) {
          if (
            autoExtendEnabled &&
            pendingWork &&
            autoExtends < autoExtendMax &&
            stepBudget < AGENT_STEPS_SAFETY_CAP
          ) {
            const add = Math.min(
              AGENT_AUTO_EXTEND_BATCH,
              AGENT_STEPS_SAFETY_CAP - stepBudget,
            );
            stepBudget += add;
            autoExtends += 1;
            this.emit(sessionId, {
              type: "thinking",
              text: `Автопродолжение ${autoExtends}/${autoExtendMax}: ещё ${add} шагов…`,
            });
          } else {
            if (!stopReason) stopReason = "budget";
            break;
          }
        }
        // Never force finish-only while the plan / coding task is still open.
        const finishOnly = inFinishWindow(i, stepBudget) && !pendingWork;
        const planFrozen = Boolean(workingMemory.planFrozen) && steps.length > 0;
        const phase = resolveAgentPhase({ planFrozen, steps, finishOnly });
        const curPlan = currentPlanStep(steps);
        // Match plan step ids ("1","2",…) so ChatPage checklist updates.
        const stepId = planFrozen && curPlan ? curPlan.id : `p${i + 1}`;
        const stepLabel = showStepCap
          ? `Шаг ${i + 1}/${stepBudget}`
          : `Шаг ${i + 1}`;
        this.emit(sessionId, { type: "step_start", stepId });
        this.emit(sessionId, {
          type: "thinking",
          text:
            phase === "finish_only"
              ? `${stepLabel}: финальный ответ…`
              : phase === "execute"
                ? `${stepLabel}: исполнение плана…`
                : `${stepLabel}: составление плана…`,
        });
        if (phase === "finish_only" && planFrozen) {
          transcript.push({
            role: "user",
            content:
              "Работа по плану завершена. ЗАПРЕЩЕНЫ новые tool. Верни JSON с final (краткий итог) или tool finish.",
          });
        }

        // Inject phase instruction once per phase (not every tool turn).
        syncSystem();
        if (lastPhaseKind !== phase) {
          const phaseHint =
            phase === "plan"
              ? planPhaseInstruction(wantsFiles)
              : executePhaseHint(curPlan, steps);
          transcript.push({ role: "user", content: phaseHint });
          lastPhaseKind = phase;
        }

        let raw: string;
        try {
          // Coding writes need a large completion budget (JSON + full file content).
          // Plan-only phase stays smaller; exec with files can use most of the window.
          const ctx = params.context || 8192;
          const want = !planFrozen
            ? Math.max(params.maxTokens || 0, 1536)
            : wantsFiles
              ? Math.max(params.maxTokens || 0, 8192)
              : Math.max(params.maxTokens || 0, 4096);
          const maxTokens = clampCompletionTokens(ctx, want, {
            min: planFrozen ? 1024 : 512,
            promptReserveRatio: !planFrozen ? 0.45 : wantsFiles ? 0.25 : 0.35,
            minPromptReserve: 512,
          });
          const runtimeStatus = this.chat.getRuntime().getStatus();
          const modelIdentity = modelIdentityForTuning(runtimeStatus);
          const family = detectModelFamily(modelIdentity);
          const tuning = agentTuningForFamily(family, modelIdentity);
          const constraintPrefer = preferredConstraintMode(family, modelIdentity);
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
            text: `${stepLabel}: контекст ~${usedTok}/${ctx} tok · жду модель…`,
          });
          try {
            raw = await this.chat.completeJson(packed, callParams, sessionId, {
              extraToolNames: phase === "plan" ? [] : extraToolNames,
              extraTools: phase === "plan" ? [] : mcpTools,
              compact: compactTools,
              planOnly: phase === "plan",
              preferredConstraint:
                phase === "plan" ? "json_schema" : constraintPrefer,
            });
            truncationStreak = 0;
          } catch (err) {
            if (this.cancelled) throw err;
            if (isLlmTruncatedError(err)) {
              truncationStreak += 1;
              this.emit(sessionId, {
                type: "thinking",
                text: `Ответ обрезан по max_tokens (${truncationStreak}/${AGENT_TRUNCATION_MAX})`,
              });
              if (truncationStreak >= AGENT_TRUNCATION_MAX || finishOnly) {
                this.emit(sessionId, {
                  type: "step_done",
                  stepId,
                  detail: "truncation → final",
                });
                transcript.push({
                  role: "user",
                  content:
                    "Слишком много обрезок. Больше не пиши крупные write_file. Верни JSON с final: краткий итог и что осталось сделать.",
                });
                unbillStep();
                continue;
              }
              this.emit(sessionId, {
                type: "step_done",
                stepId,
                detail: "truncated",
              });
              transcript.push({
                role: "user",
                content:
                  "Предыдущий ответ обрезан (finish_reason=length). НЕ пытайся уместить всё в один write_file. " +
                  "Короткий thought + один небольшой write_file. Верни один tool JSON.",
              });
              unbillStep();
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
              extraToolNames: phase === "plan" ? [] : extraToolNames,
              extraTools: phase === "plan" ? [] : mcpTools,
              compact: compactTools,
              planOnly: phase === "plan",
              preferredConstraint:
                phase === "plan" ? "json_schema" : constraintPrefer,
            });
            truncationStreak = 0;
          }
        } catch (err) {
          if (this.cancelled || (err instanceof Error && /отмен/i.test(err.message))) {
            this.emit(sessionId, { type: "cancelled" });
            return;
          }
          if (isLlmTruncatedError(err)) {
            truncationStreak += 1;
            this.emit(sessionId, {
              type: "thinking",
              text: `Обрезка ответа (${truncationStreak}/${AGENT_TRUNCATION_MAX})`,
            });
            this.emit(sessionId, {
              type: "step_done",
              stepId,
              detail: truncationStreak >= AGENT_TRUNCATION_MAX ? "truncation cap" : "truncated",
            });
            transcript.push({
              role: "user",
              content:
                truncationStreak >= AGENT_TRUNCATION_MAX || finishOnly
                  ? "Обрезки исчерпали лимит. Верни JSON с final — итог без новых крупных файлов."
                  : "Ответ снова обрезан. Пиши МЕНЬШЕ за шаг: один небольшой write_file. Без длинного thought.",
            });
            unbillStep();
            continue;
          }
          throw err;
        }
        if (this.cancelled) {
          this.emit(sessionId, { type: "cancelled" });
          return;
        }

        const inPlanPhase = !finishOnly && !planFrozen;
        const parsed = parseAgentAction(raw, inPlanPhase ? "plan" : "execute");
        // Tiny instruct models often refuse in prose / JSON thought+final without tools.
        const refusalBlob = [
          raw,
          parsed?.thought || "",
          parsed?.final || "",
        ].join("\n");
        if (isModelRefusalText(refusalBlob)) {
          refusalStreak += 1;
          this.emit(sessionId, {
            type: "thinking",
            text: (parsed?.thought || parsed?.final || raw).replace(/\s+/g, " ").trim().slice(0, 400),
          });
          if (refusalStreak >= AGENT_REFUSAL_HARD_STOP) {
            const refuseIdentity = modelIdentityForTuning(
              this.chat.getRuntime().getStatus(),
            );
            const small = looksLikeSmallOrUnknownModel(refuseIdentity);
            const hint = small
              ? " Текущая модель слишком слабая для агента — загрузите instruct ≥7B."
              : " Сформулируйте задачу конкретнее или смените модель.";
            const msg = this.store.addMessage(sessionId, {
              role: "assistant",
              content:
                `Модель отказалась выполнять шаги агента (повторный отказ).${hint}`,
            });
            this.emit(sessionId, {
              type: "step_done",
              stepId,
              detail: "model_refusal",
            });
            this.emit(sessionId, {
              type: "incomplete",
              message: msg.content.slice(0, 400),
              reason: "no_progress",
            });
            this.emit(sessionId, { type: "stream", text: msg.content });
            this.emit(sessionId, { type: "done", messageId: msg.id });
            return;
          }
          transcript.push({ role: "assistant", content: raw.slice(0, 2000) });
          transcript.push({
            role: "user",
            content:
              "Это задача локального coding-агента, не запрещённый контент. " +
              "Верни строго JSON с tool (write_file/run_terminal/…) по текущему пункту плана. " +
              "Без отказа текстом. Пример: {\"thought\":\"пишу файл\",\"tool\":{\"name\":\"write_file\",\"args\":{\"path\":\"main.py\",\"content\":\"...\"}},\"final\":null}",
          });
          this.emit(sessionId, { type: "step_done", stepId, detail: "refusal nudge" });
          continue;
        }
        refusalStreak = 0;

        if (!parsed) {
          // Plan phase: tool/final-without-plan counts as a failed plan attempt.
          if (inPlanPhase) {
            planAttempts += 1;
            transcript.push({ role: "assistant", content: raw.slice(0, 4000) });
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
              transcript.push({
                role: "user",
                content: executePhaseHint(currentPlanStep(steps), steps),
              });
              continue;
            }
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
            unbillStep();
            continue;
          }
          repairAttempts += 1;
          const looksTruncated =
            /["']\s*$/.test(raw.trim()) ||
            /,\s*$/.test(raw.trim()) ||
            (raw.includes("{") && !raw.includes("}")) ||
            raw.length > 1500;
          transcript.push({ role: "assistant", content: raw.slice(0, 4000) });
          const repairIdentity = modelIdentityForTuning(
            this.chat.getRuntime().getStatus(),
          );
          const tuning = agentTuningForFamily(
            detectModelFamily(repairIdentity),
            repairIdentity,
          );
          const familyNudge = tuning.jsonNudge;
          const proseReject = tuning.rejectProseReasoning
            ? " Обычный текст/рассуждения без JSON отвергнуты — повтори строго JSON."
            : "";
          if (repairAttempts >= AGENT_REPAIR_HARD_STOP) {
            this.emit(sessionId, {
              type: "step_done",
              stepId,
              detail: "repair hard-stop",
            });
            if (!stopReason) stopReason = "no_progress";
            break;
          }
          if (repairAttempts >= AGENT_REPAIR_MAX || finishOnly) {
            this.emit(sessionId, {
              type: "step_done",
              stepId,
              detail: "repair cap → final",
            });
            transcript.push({
              role: "user",
              content:
                "Не удалось получить валидный JSON. Верни ТОЛЬКО: " +
                `{"thought":"итог","tool":null,"final":"${workingMemory.goal.slice(0, 80) || "Готово"} — прогресс сохранён, нужен следующий запуск."}`,
            });
            unbillStep();
            continue;
          }
          const repair =
            repairAttempts <= 2
              ? looksTruncated
                ? `Ответ обрезан. Верни ТОЛЬКО JSON: {"thought":"…","tool":{"name":"write_file","args":{…}}|null,"final":null}. Один короткий write_file.\n${familyNudge}${proseReject}`
                : `Невалидный ответ. ${familyNudge}${proseReject}`
              : looksTruncated
                ? "Снова обрезка. Ещё короче: thought 1 фраза, один tool, без final."
                : `Снова не JSON. ${familyNudge}${proseReject}`;
          this.emit(sessionId, { type: "step_done", stepId, detail: "repair" });
          transcript.push({ role: "user", content: repair });
          unbillStep();
          continue;
        }
        repairAttempts = 0;
        truncationStreak = 0;

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
          unbillStep();
          continue;
        }

        // Frozen: ignore structural plan rewrites from the model.
        if (parsed.plan?.length) {
          // Keep titles/ids; statuses only advanced by the runtime after tools.
        }

        // ——— Batch read-only tools (parallel) ———
        if (Array.isArray(parsed.tools) && parsed.tools.length && !parsed.tool?.name) {
          const batchResult = await runBatchTools({
            tools: parsed.tools,
            settings,
            normalize: normalizeToolArgs,
            browser: this.browser,
            mcp: this.mcp,
            checkpointRunId: this.checkpointRunId || undefined,
            emit: (ev) => this.emit(sessionId, ev),
            isCancelled: () => this.cancelled,
          });
          if (!batchResult.ok) {
            this.emit(sessionId, { type: "step_done", stepId, detail: "repair" });
            transcript.push({ role: "assistant", content: JSON.stringify(parsed) });
            transcript.push({
              role: "user",
              content: batchResult.error,
            });
            continue;
          }
          toolsUsed += batchResult.count;
          nonAdvancingStreak += 1;
          const combined = batchResult.combined.slice(0, TOOL_RESULT_TRANSCRIPT_CHARS * 2);
          rememberToolSuccess(
            workingMemory,
            "tools[]",
            {},
            combined.slice(0, 400),
          );
          persistScratchpad();
          this.emit(sessionId, {
            type: "step_done",
            stepId,
            detail: `tools×${batchResult.count} ok`,
          });
          transcript.push({ role: "assistant", content: JSON.stringify(parsed) });
          transcript.push({
            role: "user",
            content: `Результаты batch tools (${batchResult.count}):\n${combined}`,
          });
          if (nonAdvancingStreak > AGENT_NON_ADVANCING_MAX) {
            transcript.push({
              role: "user",
              content: wantsFiles
                ? "Хватит разведки (tools[]). Сделай write_file/apply_patch или final."
                : "Хватит разведки. Выполни действие по плану или final.",
            });
            nonAdvancingStreak = 0;
          }
          continue;
        }

        if (parsed.final && !parsed.tool) {
          // Coding: list_dir/read alone must not unlock final — except finish window / last steps.
          const noFileYet = wantsFiles && filesWritten === 0 && !finishOnly;
          const stubOnly =
            wantsFiles &&
            filesWritten > 0 &&
            !substantialWrite &&
            stubNudgeCount < 2 &&
            !finishOnly;
          const pendingLeft = steps.some((s) => s.status === "pending");
          const current = currentPlanStep(steps);
          const currentIsFinalish =
            current &&
            (current.kind === "finalize" ||
              /итог|final|finish|отчет|отчёт|резюме/i.test(current.title));
          const mustWork =
            noFileYet ||
            (!finishOnly &&
              i < stepBudget - 1 &&
              (stubOnly ||
                (!wantsFiles && toolsUsed === 0 && steps.length > 0) ||
                (pendingLeft && !currentIsFinalish && toolsUsed === 0)));
          if (mustWork) {
            if (stubOnly) stubNudgeCount += 1;
            this.emit(sessionId, {
              type: "step_done",
              stepId,
              detail: "final_blocked",
            });
            const curTitle = current
              ? ` Пункт [${current.id}]: ${current.title}.`
              : "";
            transcript.push({ role: "assistant", content: JSON.stringify(parsed) });
            transcript.push({
              role: "user",
              content: wantsFiles
                ? filesWritten === 0
                  ? `Рано для final.${curTitle} Сначала создай файлы через write_file (полный код в args.content). list_dir/read_file не считаются выполнением.`
                  : `Рано для final: запись похожа на stub.${curTitle} Допиши полный код через write_file/apply_patch (цель ≥${MIN_CODING_WRITE_CHARS} символов), затем final.`
                : `Рано для final.${curTitle} Сначала выполни текущий пункт плана инструментом.`,
            });
            // Count toward budget — otherwise thought-only loops never stop.
            continue;
          }
          let finalText = parsed.final;
          if (wantsFiles && filesWritten === 0) {
            finalText +=
              "\n\n⚠️ Файлы не были записаны до завершения (лимит шагов / финальное окно).";
          }
          const marked = skipRemainingPlan(steps);
          if (marked.length) {
            steps = marked;
            updatePlanMemory(workingMemory, steps);
            this.emit(sessionId, { type: "plan", steps });
          }
          clearPlanAfterCompletion(workingMemory);
          persistScratchpad();
          const msg = this.store.addMessage(sessionId, {
            role: "assistant",
            content: finalText,
            thinking: parsed.thought,
          });
          this.emit(sessionId, { type: "step_done", stepId, detail: "final" });
          this.emit(sessionId, { type: "stream", text: finalText });
          this.emit(sessionId, { type: "done", messageId: msg.id });
          return;
        }

        if (!parsed.tool?.name) {
          this.emit(sessionId, { type: "step_done", stepId, detail: "no tool" });
          const cur = currentPlanStep(steps);
          const curHint = cur
            ? `Текущий пункт плана [${cur.id}]: ${cur.title}.`
            : "Пункты плана уже закрыты — можно final.";
          transcript.push({ role: "assistant", content: JSON.stringify(parsed) });
          transcript.push({
            role: "user",
            content: finishOnly
              ? "Нужен final или finish. Tool на этом шаге запрещён."
              : wantsFiles
                ? `${curHint} Ты вернул thought без tool. Сейчас ОБЯЗАТЕЛЕН tool.write_file (или apply_patch) с полным кодом в args — не описывай файлы в thought/final. Пример: {"thought":"создаю main","tool":{"name":"write_file","args":{"path":"tetris/main.py","content":"..."}},"final":null}`
                : `${curHint} Нужен один tool или final. Не отвечай только thought.`,
          });
          // Count toward budget — empty turns must not loop forever.
          continue;
        }

        if (finishOnly && parsed.tool.name !== "finish") {
          this.emit(sessionId, {
            type: "step_done",
            stepId,
            detail: "finish window — tool blocked",
          });
          transcript.push({ role: "assistant", content: JSON.stringify(parsed) });
          transcript.push({
            role: "user",
            content:
              "Финальное окно: только final или tool finish. Кратко подведи итог без новых инструментов.",
          });
          continue;
        }

        const toolName = parsed.tool.name;
        const coerced = coerceToolArgs(toolName, parsed.tool.args || {});
        const argCheck = validateToolArgs(
          toolName,
          coerced,
          extraToolNames,
          mcpSchemas,
        );
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

        // Fingerprint before emitting tool_call so identical retries don't spam the UI.
        const fp = toolFingerprint(toolName, args);
        if (fp === lastToolFp) identicalToolStreak += 1;
        else {
          identicalToolStreak = 1;
          lastToolFp = fp;
        }
        if (toolName !== "finish" && identicalToolStreak > AGENT_IDENTICAL_TOOL_MAX) {
          this.emit(sessionId, {
            type: "step_done",
            stepId,
            detail: "identical tool",
          });
          const badPath = String(args.path || "");
          const pathHint =
            /codebase-index|\.kovi|__.__kovi/i.test(badPath)
              ? " Путь похож на служебный индекс — пиши в tetris/main.py или src/main.py."
              : "";
          const pendingOnlyFinalize =
            steps.length > 0 &&
            !steps.some(
              (s) =>
                s.status === "pending" &&
                stepKindOf(s) !== "finalize",
            );
          transcript.push({ role: "assistant", content: JSON.stringify(parsed) });
          if (!identicalNudgeSent) {
            identicalNudgeSent = true;
            transcript.push({
              role: "user",
              content:
                `Ты повторяешь тот же ${toolName} с теми же аргументами.${pathHint} ` +
                `Смени path/args или другой tool. Если работа сделана — final/finish.`,
            });
            continue;
          }
          if (pendingOnlyFinalize || identicalToolStreak > AGENT_IDENTICAL_TOOL_MAX + 2) {
            transcript.push({
              role: "user",
              content:
                "Повтор инструмента исчерпан. Верни JSON с final (краткий честный итог) или tool finish.",
            });
            identicalToolStreak = 0;
            lastToolFp = null;
            continue;
          }
          identicalToolStreak = 0;
          lastToolFp = null;
          transcript.push({
            role: "user",
            content:
              `Смени аргументы ${toolName} или вызови другой tool / final.${pathHint}`,
          });
          continue;
        }

        const callId = uuid();
        this.emit(sessionId, {
          type: "tool_call",
          name: toolName,
          args,
          callId,
          status: "proposed",
        });

        if (toolName === "finish") {
          const blockFinishNoFile = wantsFiles && filesWritten === 0 && !finishOnly;
          const blockFinishStub =
            wantsFiles &&
            filesWritten > 0 &&
            !substantialWrite &&
            stubNudgeCount < 2 &&
            !finishOnly &&
            i < stepBudget - 1;
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
          let summary = String(args.summary || parsed.final || "Готово");
          if (wantsFiles && filesWritten === 0) {
            summary +=
              "\n\n⚠️ Файлы не были записаны до завершения.";
          }
          if (steps.length) {
            steps = skipRemainingPlan(steps);
            updatePlanMemory(workingMemory, steps);
            this.emit(sessionId, { type: "plan", steps });
          }
          clearPlanAfterCompletion(workingMemory);
          persistScratchpad();
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
          this.emit(sessionId, { type: "step_done", stepId, detail: "finish" });
          this.emit(sessionId, { type: "stream", text: summary });
          this.emit(sessionId, { type: "done", messageId: msg.id });
          return;
        }

        // Explore tools against an explore step are progress — do not count toward no_progress.
        const curForProgress = currentPlanStep(steps);
        const exploreProgress =
          isExploreTool(toolName) &&
          curForProgress &&
          (curForProgress.kind === "explore" ||
            (!curForProgress.kind &&
              /уточн|развед|list|read|search|обзор|состоян|explore/i.test(
                curForProgress.title,
              )));
        if (!PLAN_ADVANCING_TOOLS.has(toolName) && !exploreProgress) {
          nonAdvancingStreak += 1;
          if (nonAdvancingStreak > AGENT_NON_ADVANCING_HARD_STOP) {
            this.emit(sessionId, {
              type: "tool_result",
              callId,
              result: "Слишком много разведочных tool подряд",
              isError: true,
            });
            this.emit(sessionId, {
              type: "step_done",
              stepId,
              detail: "non-advancing hard-stop",
            });
            if (!stopReason) stopReason = "no_progress";
            break;
          }
        } else {
          nonAdvancingStreak = 0;
        }

        const confirm = await this.confirmIfNeeded(
          sessionId,
          toolName,
          args,
          settings,
          callId,
        );
        if (this.cancelled) {
          this.emit(sessionId, { type: "cancelled" });
          return;
        }
        if (confirm === "timeout") {
          const deny = `Подтверждение «${toolName}» истекло`;
          this.emit(sessionId, { type: "tool_result", callId, result: deny, isError: true });
          this.emit(sessionId, { type: "step_done", stepId, detail: deny });
          const msg = this.store.addMessage(sessionId, {
            role: "assistant",
            content: `${deny}. Можно нажать «Продолжить».`,
          });
          this.emit(sessionId, { type: "stream", text: msg.content });
          this.emit(sessionId, {
            type: "incomplete",
            message: msg.content.slice(0, 400),
            reason: "confirm_timeout",
          });
          this.emit(sessionId, { type: "done", messageId: msg.id });
          return;
        }
        if (confirm === "rejected") {
          const deny = "Пользователь отклонил действие";
          this.emit(sessionId, { type: "tool_result", callId, result: deny, isError: true });
          this.emit(sessionId, { type: "step_done", stepId, detail: deny });
          transcript.push({ role: "assistant", content: JSON.stringify(parsed) });
          transcript.push({ role: "user", content: `Результат инструмента ${toolName}: ${deny}` });
          continue;
        }

        try {
          const normalizedArgs = normalizeToolArgs(toolName, args, settings.projectRoot);
          this.emit(sessionId, {
            type: "tool_call",
            name: toolName,
            args: normalizedArgs,
            callId,
            status: "running",
          });
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
              projectContextCache.invalidateRoot(settings.projectRoot);
              await invalidateIndexPaths(settings.projectRoot, [targetPath]).catch(
                () => undefined,
              );
            }
          }
          let kindMismatchHint: string | null = null;
          if (steps.length) {
            const curStep = currentPlanStep(steps);
            if (shouldAdvancePlanOnTool(curStep, toolName, normalizedArgs)) {
              steps = markCurrentPlanDone(steps, toolName);
              kindMismatchStreak = 0;
              this.emit(sessionId, { type: "plan", steps });
            } else {
              const kind = stepKindOf(curStep);
              if (kind === "run" || kind === "verify") {
                kindMismatchStreak += 1;
                if (kindMismatchStreak === 2) {
                  kindMismatchHint =
                    `Текущий пункт плана (${kind}): нужен run_terminal (или browser_*). ` +
                    `Сначала запусти проверку.`;
                } else if (kindMismatchStreak >= 3) {
                  steps = skipCurrentPlanStep(
                    steps,
                    `soft-skip: ожидали ${kind}, был ${toolName}`,
                  );
                  kindMismatchStreak = 0;
                  this.emit(sessionId, { type: "plan", steps });
                  this.emit(sessionId, {
                    type: "thinking",
                    text: `Пункт ${curStep?.id || "?"} пропущен (нет run_terminal) — продолжаю.`,
                  });
                }
              } else {
                kindMismatchStreak = 0;
              }
            }
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
          if (kindMismatchHint) {
            followUp += `\n\n${kindMismatchHint}`;
          }
          if (
            toolName === "run_terminal" &&
            /exit:\s*(?!0\b)\d+/i.test(result)
          ) {
            followUp +=
              `\n\nУчти блок «Диагностика» (если есть): исправь код через write_file/apply_patch и повтори запуск.`;
          }
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
          if (
            !PLAN_ADVANCING_TOOLS.has(toolName) &&
            nonAdvancingStreak > AGENT_NON_ADVANCING_MAX &&
            nonAdvancingStreak % AGENT_NON_ADVANCING_MAX === 1
          ) {
            transcript.push({
              role: "user",
              content: wantsFiles
                ? "Хватит разведки. Сделай write_file/apply_patch или final."
                : "Хватит разведки. Выполни действие по плану или final.",
            });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          rememberToolError(workingMemory, toolName, message);
          // Do NOT mark the plan step failed on a single tool error — the model may retry
          // with a fixed path. Premature "failed" made the checklist skip the real work.
          persistScratchpad();
          this.emit(sessionId, {
            type: "tool_result",
            callId,
            result: message,
            isError: true,
          });
          this.emit(sessionId, { type: "step_done", stepId, detail: message.slice(0, 160) });
          const pathHint = /codebase-index|\.kovi|служебн/i.test(message)
            ? "\nИсправь path: пиши в tetris/main.py или src/main.py — НЕ в .kovi/codebase-index."
            : "";
          transcript.push({ role: "assistant", content: JSON.stringify(parsed) });
          transcript.push({
            role: "user",
            content: `Ошибка инструмента ${toolName}: ${message}${pathHint}`,
          });
        }
      }

      const { content: exhaustContent, event: incompleteEv } = buildIncompleteEvent({
        workingMemory,
        wantsFiles,
        filesWritten,
        toolsUsed,
        substantialWrite,
        stopReason,
      });
      const msg = this.store.addMessage(sessionId, {
        role: "assistant",
        content: exhaustContent,
      });
      this.emit(sessionId, { type: "stream", text: exhaustContent });
      this.emit(sessionId, incompleteEv);
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

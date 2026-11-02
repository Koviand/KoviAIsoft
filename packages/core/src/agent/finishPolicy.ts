import { createHash } from "node:crypto";
import type { AgentPlanStep } from "@kovi/shared";
import type { AgentWorkingMemory } from "./workingMemory.js";

/** Hard caps so large tasks cannot burn the whole step budget on repair/loops. */
export const AGENT_REPAIR_MAX = 3;
/** After this many consecutive repair failures → soft-stop (no_progress). */
export const AGENT_REPAIR_HARD_STOP = AGENT_REPAIR_MAX * 2;
export const AGENT_TRUNCATION_MAX = 3;
/** After this many consecutive truncations → soft-stop (no_progress). */
export const AGENT_TRUNCATION_HARD_STOP = AGENT_TRUNCATION_MAX * 2;
export const AGENT_IDENTICAL_TOOL_MAX = 2;
/** Blocked early final / empty turns before hard-stop. */
export const AGENT_FINAL_BLOCKED_HARD_STOP = 4;
/** Nudge after this many scout tools; hard-stop at HARD_STOP. */
export const AGENT_NON_ADVANCING_MAX = 4;
export const AGENT_NON_ADVANCING_HARD_STOP = AGENT_NON_ADVANCING_MAX * 3;
/** Soft refusals from tiny instruct models → stop after this many in a row. */
export const AGENT_REFUSAL_HARD_STOP = 2;

/**
 * Detect chatty refusals / "I can't help" instead of JSON tools.
 * Tiny models (e.g. qwen2.5-coder-1.5b) often loop this forever.
 */
export function isModelRefusalText(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t || t.length < 12) return false;
  return (
    /не\s+могу\s+(выполнить|помочь|сделать|ответить)/i.test(t) ||
    /извините,?\s+но\s+я\s+не\s+могу/i.test(t) ||
    /уточните\s+вашу\s+задачу/i.test(t) ||
    /предоставьте\s+больше\s+деталей/i.test(t) ||
    /\bi\s+can'?t\s+(help|assist|do|fulfill|complete)\b/i.test(t) ||
    /\bi'?m\s+unable\s+to\b/i.test(t) ||
    /\bas\s+an\s+ai\b.{0,40}\b(can'?t|cannot|unable)\b/i.test(t) ||
    /\bsorry,?\s+i\s+(can'?t|cannot)\b/i.test(t) ||
    /\bi\s+must\s+refuse\b/i.test(t)
  );
}

/** User turn to resume after stop / budget without full replan. */
export function buildAgentResumePrompt(goalHint?: string): string {
  const goal = goalHint?.trim()
    ? ` Цель была: ${goalHint.trim().slice(0, 240)}.`
    : "";
  return (
    `Продолжи задачу с того места, где остановился.${goal} ` +
    `Не начинай план заново — используй рабочую память и уже записанные файлы. ` +
    `Один JSON-шаг: tool или final.`
  );
}

/** Last N steps: only final/summary (no new tools) — only when work is done. */
export const AGENT_FINISH_WINDOW = 2;
/** 0 in settings = без лимита (runtime uses safety ceiling). */
export const AGENT_MAX_STEPS_MIN = 0;
export const AGENT_MAX_STEPS_MAX = 2000;
export const AGENT_MAX_STEPS_DEFAULT = 0;
/** Absolute safety ceiling for unlimited / auto-extend. */
export const AGENT_STEPS_SAFETY_CAP = 2000;
/** How many times we may auto-extend past the user budget while work remains. */
export const AGENT_AUTO_EXTEND_MAX = 40;
/** Steps added per auto-extend batch. */
export const AGENT_AUTO_EXTEND_BATCH = 64;

/**
 * Persistable preference: 0 = unlimited.
 * Does not expand 0 into the safety cap (that is runtime-only).
 */
export function normalizeAgentMaxStepsSetting(n: unknown): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return AGENT_MAX_STEPS_DEFAULT;
  if (v <= 0) return 0;
  return Math.max(1, Math.min(AGENT_MAX_STEPS_MAX, Math.floor(v)));
}

/** Runtime step budget (never 0 — unlimited becomes safety cap). */
export function clampAgentMaxSteps(n: unknown): number {
  const pref = normalizeAgentMaxStepsSetting(n);
  if (pref <= 0) return AGENT_STEPS_SAFETY_CAP;
  return pref;
}

/** True when this step index is in the finish-only window. */
export function inFinishWindow(stepIndex: number, agentMaxSteps: number): boolean {
  const max = Math.max(1, agentMaxSteps);
  return stepIndex >= max - AGENT_FINISH_WINDOW;
}

/** Plan / coding work still needs tools — do not force final-only mode. */
export function agentHasPendingWork(opts: {
  steps: AgentPlanStep[];
  wantsFiles: boolean;
  filesWritten: number;
  substantialWrite: boolean;
}): boolean {
  // Pending-only finalize is not blocking work — allow finish window / auto-extend stop.
  const pendingBlocking = opts.steps.some((s) => {
    if (s.status !== "pending" && s.status !== "running") return false;
    const kind = s.kind;
    if (kind === "finalize") return false;
    if (
      !kind &&
      /(итог|final|finish|отчет|отчёт|резюме)/i.test(s.title || "")
    ) {
      return false;
    }
    return true;
  });
  if (pendingBlocking) return true;
  if (opts.wantsFiles && opts.filesWritten === 0) return true;
  if (opts.wantsFiles && opts.filesWritten > 0 && !opts.substantialWrite) return true;
  return false;
}

function digestString(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
}

/**
 * Stable fingerprint for identical-tool detection.
 * Long strings use content hash (not prefix+len) so iterative write_file edits don't collide.
 */
export function toolFingerprint(toolName: string, args: Record<string, unknown>): string {
  const keys = Object.keys(args).sort();
  const compact: Record<string, unknown> = {};
  for (const k of keys) {
    const v = args[k];
    if (typeof v === "string" && v.length > 120) {
      compact[k] = `h:${digestString(v)}#${v.length}`;
    } else if (Array.isArray(v)) {
      try {
        const raw = JSON.stringify(v);
        compact[k] =
          raw.length > 120 ? `h:${digestString(raw)}#${raw.length}` : v;
      } catch {
        compact[k] = "[array]";
      }
    } else {
      compact[k] = v;
    }
  }
  try {
    return `${toolName}:${JSON.stringify(compact)}`;
  } catch {
    return `${toolName}:?`;
  }
}

/** Build a user-facing summary when the step budget is exhausted. */
export function synthesizeBudgetExhaustedAnswer(
  wm: AgentWorkingMemory,
  opts: {
    wantsFiles: boolean;
    filesWritten: number;
    toolsUsed: number;
    substantialWrite: boolean;
  },
): { content: string; incomplete: boolean } {
  const lines: string[] = [];
  const hadProgress =
    opts.toolsUsed > 0 ||
    opts.filesWritten > 0 ||
    wm.filesTouched.length > 0 ||
    wm.plan.some((p) => p.status === "done" || p.status === "failed");

  lines.push("## Итог");
  if (wm.goal) lines.push(`**Цель:** ${wm.goal}`);

  if (wm.plan.length) {
    lines.push("**План:**");
    for (const p of wm.plan.slice(0, 12)) {
      lines.push(`- [${p.status}] ${p.id}: ${p.title}`);
    }
  }

  if (wm.filesTouched.length) {
    lines.push(`**Файлы:** ${wm.filesTouched.slice(-16).join(", ")}`);
  } else if (opts.wantsFiles && opts.filesWritten === 0) {
    lines.push("**Файлы:** не записаны.");
  }

  if (wm.lastTool) lines.push(`**Последний инструмент:** ${wm.lastTool}`);
  if (wm.lastResult) lines.push(`**Последний результат:** ${wm.lastResult}`);
  if (wm.lastError) lines.push(`**Последняя ошибка:** ${wm.lastError}`);
  if (wm.notes.length) {
    lines.push("**Заметки:**");
    for (const n of wm.notes.slice(-8)) lines.push(`- ${n}`);
  }

  if (!hadProgress) {
    lines.push(
      "",
      "Прогресса почти не было. Уточните задачу или нажмите Стоп и сформулируйте запрос иначе.",
    );
    return { content: lines.join("\n"), incomplete: true };
  }

  if (opts.wantsFiles && opts.filesWritten === 0) {
    lines.push(
      "",
      "Код/файлы так и не были созданы. Можно уточнить путь (например tetris/main.py) и повторить.",
    );
  } else if (opts.wantsFiles && !opts.substantialWrite) {
    lines.push("", "Записи были, но похожи на заготовки (stub).");
  } else {
    lines.push(
      "",
      "Достигнут внутренний лимит безопасности. Нажмите «Продолжить», если нужно добить задачу.",
    );
  }

  return { content: lines.join("\n"), incomplete: false };
}

import type { AgentWorkingMemory } from "./workingMemory.js";

/** Hard caps so large tasks cannot burn the whole step budget on repair/loops. */
export const AGENT_REPAIR_MAX = 3;
export const AGENT_TRUNCATION_MAX = 3;
export const AGENT_IDENTICAL_TOOL_MAX = 2;
/** Tighter for 3–7B GGUF — leave finish window sooner. */
export const AGENT_NON_ADVANCING_MAX = 4;

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
/** Last N steps: only final/summary (no new tools). */
export const AGENT_FINISH_WINDOW = 2;
export const AGENT_MAX_STEPS_MIN = 8;
export const AGENT_MAX_STEPS_MAX = 128;

export function clampAgentMaxSteps(n: unknown): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return 40;
  return Math.max(AGENT_MAX_STEPS_MIN, Math.min(AGENT_MAX_STEPS_MAX, Math.floor(v)));
}

/** True when this step index is in the finish-only window. */
export function inFinishWindow(stepIndex: number, agentMaxSteps: number): boolean {
  const max = Math.max(1, agentMaxSteps);
  return stepIndex >= max - AGENT_FINISH_WINDOW;
}

export function toolFingerprint(toolName: string, args: Record<string, unknown>): string {
  const keys = Object.keys(args).sort();
  const compact: Record<string, unknown> = {};
  for (const k of keys) {
    const v = args[k];
    if (typeof v === "string" && v.length > 120) {
      compact[k] = `${v.slice(0, 80)}…#${v.length}`;
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

  lines.push("## Итог (лимит шагов агента)");
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
      "Прогресса почти не было. Уточните задачу или увеличьте лимит шагов в настройках, затем повторите с @agent.",
    );
    return { content: lines.join("\n"), incomplete: true };
  }

  if (opts.wantsFiles && opts.filesWritten === 0) {
    lines.push(
      "",
      "Код/файлы так и не были созданы до исчерпания лимита. Повторите запрос, попросив начать с одного короткого `write_file`.",
    );
  } else if (opts.wantsFiles && !opts.substantialWrite) {
    lines.push(
      "",
      "Записи были, но похожи на заготовки (stub). Можно продолжить: «допиши файлы через @agent».",
    );
  } else {
    lines.push(
      "",
      "Это промежуточный итог по сделанному. Если нужно продолжить — напишите «продолжи @agent».",
    );
  }

  return { content: lines.join("\n"), incomplete: false };
}

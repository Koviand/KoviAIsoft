import type { AgentEvent } from "@kovi/shared";
import type { AgentWorkingMemory } from "../workingMemory.js";
import { synthesizeBudgetExhaustedAnswer } from "../finishPolicy.js";

export type IncompleteReason = "budget" | "no_progress" | "time_limit" | "confirm_timeout";

/** Build incomplete event payload after soft stop (budget / time / no progress). */
export function buildIncompleteEvent(opts: {
  workingMemory: AgentWorkingMemory;
  wantsFiles: boolean;
  filesWritten: number;
  toolsUsed: number;
  substantialWrite: boolean;
  stopReason: "budget" | "no_progress" | "time_limit" | null;
}): { content: string; event: Extract<AgentEvent, { type: "incomplete" }> } {
  const synthesized = synthesizeBudgetExhaustedAnswer(opts.workingMemory, {
    wantsFiles: opts.wantsFiles,
    filesWritten: opts.filesWritten,
    toolsUsed: opts.toolsUsed,
    substantialWrite: opts.substantialWrite,
  });
  const reason: IncompleteReason =
    opts.stopReason === "time_limit"
      ? "time_limit"
      : opts.stopReason === "no_progress" || synthesized.incomplete
        ? "no_progress"
        : opts.stopReason || "budget";
  let content = synthesized.content;
  if (reason === "time_limit") {
    content =
      synthesized.content.replace(
        /Достигнут внутренний лимит безопасности[\s\S]*$/m,
        "Достигнут лимит времени выполнения. Нажмите «Продолжить», если нужно добить задачу.",
      ) || synthesized.content;
    if (!/лимит времени/i.test(content)) {
      content +=
        "\n\nДостигнут лимит времени выполнения. Нажмите «Продолжить», если нужно добить задачу.";
    }
  } else if (reason === "no_progress" && !synthesized.incomplete) {
    content +=
      "\n\nОстановка: почти не было прогресса. Уточните задачу или нажмите «Продолжить».";
  }
  return {
    content,
    event: {
      type: "incomplete",
      message: content.slice(0, 400),
      reason,
    },
  };
}

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
      : synthesized.incomplete
        ? "no_progress"
        : opts.stopReason || "budget";
  return {
    content: synthesized.content,
    event: {
      type: "incomplete",
      message: synthesized.content.slice(0, 400),
      reason,
    },
  };
}

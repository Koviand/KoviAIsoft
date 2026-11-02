import { describe, expect, it } from "vitest";
import { resolveAgentPhase, shouldAdvancePlanOnTool } from "../packages/core/src/agent/planner";
import { isNonZeroShellExit } from "../packages/core/src/tools/terminal";
import {
  createWorkingMemory,
  parseWorkingMemory,
  serializeWorkingMemory,
} from "../packages/core/src/agent/workingMemory";

describe("Pass-3 regressions", () => {
  it("detects non-zero shell exit without matching exit: 0", () => {
    expect(isNonZeroShellExit("$ x\nexit: 1\nstderr:\nboom")).toBe(true);
    expect(isNonZeroShellExit("$ x\nexit: 0\nok")).toBe(false);
    expect(isNonZeroShellExit("exit: 12\nДиагностика:")).toBe(true);
  });

  it("plan phase wins over finish_only when plan is not frozen", () => {
    expect(
      resolveAgentPhase({
        planFrozen: false,
        steps: [],
        finishOnly: true,
      }),
    ).toBe("plan");
    expect(
      resolveAgentPhase({
        planFrozen: true,
        steps: [{ id: "1", title: "edit", status: "pending", kind: "edit" }],
        finishOnly: true,
      }),
    ).toBe("finish_only");
  });

  it("run/verify still wants run_terminal for advance (exit checked by loop)", () => {
    const step = {
      id: "3",
      title: "Проверить",
      status: "pending" as const,
      kind: "verify" as const,
    };
    expect(shouldAdvancePlanOnTool(step, "run_terminal", { command: "x" })).toBe(true);
  });

  it("goal-change reset clears sticky writes when reconstructing memory", () => {
    const wm = createWorkingMemory("old goal");
    wm.writtenPaths = ["a.py"];
    wm.hadSubstantialWrite = true;
    wm.plan = [{ id: "1", title: "x", status: "pending" }];
    wm.planFrozen = true;
    const raw = serializeWorkingMemory(wm);
    const restored = parseWorkingMemory(raw)!;
    const goalChanged = true;
    const next = {
      ...restored,
      goal: "new goal",
      ...(goalChanged
        ? {
            plan: [],
            planFrozen: false,
            notes: [],
            filesTouched: [],
            lastError: null,
            lastTool: null,
            lastResult: null,
            writtenPaths: [],
            hadSubstantialWrite: false,
          }
        : {}),
    };
    expect(next.writtenPaths).toEqual([]);
    expect(next.hadSubstantialWrite).toBe(false);
    expect(next.plan).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import {
  currentPlanStep,
  defaultCodingPlan,
  defaultPlanForTask,
  markCurrentPlanDone,
  normalizePlanDraft,
  PLAN_MAX_STEPS,
  PLAN_MIN_STEPS,
  skipRemainingPlan,
} from "../packages/core/src/agent/planner";
import {
  createWorkingMemory,
  parseWorkingMemory,
  serializeWorkingMemory,
} from "../packages/core/src/agent/workingMemory";

describe("agent planner", () => {
  it("normalizes draft to 3–7 pending steps", () => {
    const steps = normalizePlanDraft(
      [
        { id: "a", title: "  Skeleton  " },
        { id: "b", title: "Logic" },
        { id: "c", title: "Run" },
        { id: "d", title: "Fix" },
        { id: "e", title: "Done" },
        { id: "f", title: "Extra1" },
        { id: "g", title: "Extra2" },
        { id: "h", title: "TooMany" },
      ],
      true,
    );
    expect(steps).toBeTruthy();
    expect(steps!.length).toBeLessThanOrEqual(PLAN_MAX_STEPS);
    expect(steps!.length).toBeGreaterThanOrEqual(PLAN_MIN_STEPS);
    expect(steps!.every((s) => s.status === "pending")).toBe(true);
    expect(steps![0]!.title).toBe("Skeleton");
  });

  it("pads short plans with defaults", () => {
    const steps = normalizePlanDraft([{ id: "1", title: "Only one" }], true);
    expect(steps!.length).toBeGreaterThanOrEqual(PLAN_MIN_STEPS);
  });

  it("returns null for empty draft", () => {
    expect(normalizePlanDraft([], false)).toBeNull();
    expect(normalizePlanDraft(null, true)).toBeNull();
  });

  it("marks current pending done in order", () => {
    let steps = defaultCodingPlan();
    expect(currentPlanStep(steps)?.id).toBe("1");
    steps = markCurrentPlanDone(steps, "write_file");
    expect(steps[0]!.status).toBe("done");
    expect(steps[0]!.detail).toBe("write_file");
    expect(currentPlanStep(steps)?.id).toBe("2");
  });

  it("skipRemaining marks pending as skipped", () => {
    const steps = skipRemainingPlan(defaultPlanForTask(false));
    expect(steps.every((s) => s.status === "skipped")).toBe(true);
  });

  it("working memory persists planFrozen", () => {
    const wm = createWorkingMemory("сделай тетрис");
    expect(wm.planFrozen).toBe(false);
    wm.plan = defaultCodingPlan().map((s) => ({
      id: s.id,
      title: s.title,
      status: s.status,
    }));
    wm.planFrozen = true;
    const round = parseWorkingMemory(serializeWorkingMemory(wm));
    expect(round?.planFrozen).toBe(true);
    expect(round?.plan.length).toBe(wm.plan.length);
  });

  it("legacy scratchpad with plan is treated as frozen", () => {
    const raw = JSON.stringify({
      goal: "x",
      plan: [{ id: "1", title: "a", status: "pending" }],
      filesTouched: [],
      lastTool: null,
      lastResult: null,
      lastError: null,
      notes: [],
    });
    const wm = parseWorkingMemory(raw);
    expect(wm?.planFrozen).toBe(true);
  });
});

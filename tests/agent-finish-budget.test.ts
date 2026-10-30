import { describe, expect, it } from "vitest";
import {
  AGENT_FINISH_WINDOW,
  AGENT_NON_ADVANCING_MAX,
  AGENT_REPAIR_MAX,
  AGENT_TRUNCATION_MAX,
  buildAgentResumePrompt,
  clampAgentMaxSteps,
  inFinishWindow,
  synthesizeBudgetExhaustedAnswer,
  toolFingerprint,
} from "../packages/core/src/agent/finishPolicy";
import { createWorkingMemory } from "../packages/core/src/agent/workingMemory";

describe("clampAgentMaxSteps", () => {
  it("clamps to 8…128", () => {
    expect(clampAgentMaxSteps(0)).toBe(8);
    expect(clampAgentMaxSteps(999999)).toBe(128);
    expect(clampAgentMaxSteps(40)).toBe(40);
    expect(clampAgentMaxSteps("nope")).toBe(40);
  });
});

describe("inFinishWindow", () => {
  it("last AGENT_FINISH_WINDOW steps are finish-only", () => {
    expect(AGENT_FINISH_WINDOW).toBe(2);
    expect(inFinishWindow(38, 40)).toBe(true);
    expect(inFinishWindow(39, 40)).toBe(true);
    expect(inFinishWindow(37, 40)).toBe(false);
  });
});

describe("toolFingerprint", () => {
  it("stable for same args; shortens long content", () => {
    const a = toolFingerprint("write_file", { path: "a.ts", content: "x".repeat(200) });
    const b = toolFingerprint("write_file", { path: "a.ts", content: "x".repeat(200) });
    expect(a).toBe(b);
    expect(a).toContain("#200");
  });
});

describe("synthesizeBudgetExhaustedAnswer", () => {
  it("marks incomplete when no progress", () => {
    const wm = createWorkingMemory("сделай тетрис");
    const r = synthesizeBudgetExhaustedAnswer(wm, {
      wantsFiles: true,
      filesWritten: 0,
      toolsUsed: 0,
      substantialWrite: false,
    });
    expect(r.incomplete).toBe(true);
    expect(r.content).toMatch(/Итог/);
  });

  it("returns finished-style summary when there was progress", () => {
    const wm = createWorkingMemory("игра");
    wm.filesTouched.push("main.py");
    wm.plan = [{ id: "1", title: "write", status: "done" }];
    wm.notes.push("wrote main.py");
    const r = synthesizeBudgetExhaustedAnswer(wm, {
      wantsFiles: true,
      filesWritten: 1,
      toolsUsed: 3,
      substantialWrite: true,
    });
    expect(r.incomplete).toBe(false);
    expect(r.content).toMatch(/main\.py/);
    expect(r.content).toMatch(/промежуточный|итог/i);
  });
});

describe("hard caps constants", () => {
  it("repair and truncation caps are finite and small", () => {
    expect(AGENT_REPAIR_MAX).toBeLessThanOrEqual(4);
    expect(AGENT_TRUNCATION_MAX).toBeLessThanOrEqual(4);
    expect(AGENT_NON_ADVANCING_MAX).toBe(4);
  });
});

describe("buildAgentResumePrompt", () => {
  it("includes goal and no-replan instruction", () => {
    const p = buildAgentResumePrompt("сделай калькулятор");
    expect(p).toMatch(/калькулятор/);
    expect(p).toMatch(/Не начинай план заново/);
  });
});

import { describe, expect, it } from "vitest";
import {
  AGENT_FINISH_WINDOW,
  AGENT_NON_ADVANCING_MAX,
  AGENT_REFUSAL_HARD_STOP,
  AGENT_REPAIR_MAX,
  AGENT_STEPS_SAFETY_CAP,
  AGENT_TRUNCATION_MAX,
  AGENT_TRUNCATION_HARD_STOP,
  AGENT_FINAL_BLOCKED_HARD_STOP,
  agentHasPendingWork,
  buildAgentResumePrompt,
  clampAgentMaxSteps,
  inFinishWindow,
  isModelRefusalText,
  normalizeAgentMaxStepsSetting,
  synthesizeBudgetExhaustedAnswer,
  toolFingerprint,
} from "../packages/core/src/agent/finishPolicy";
import { createWorkingMemory } from "../packages/core/src/agent/workingMemory";

describe("normalizeAgentMaxStepsSetting", () => {
  it("keeps 0 as unlimited preference", () => {
    expect(normalizeAgentMaxStepsSetting(0)).toBe(0);
    expect(normalizeAgentMaxStepsSetting(-1)).toBe(0);
    expect(normalizeAgentMaxStepsSetting(40)).toBe(40);
    expect(normalizeAgentMaxStepsSetting(999999)).toBe(2000);
    expect(normalizeAgentMaxStepsSetting("nope")).toBe(0);
  });
});

describe("clampAgentMaxSteps", () => {
  it("maps 0 to safety cap; clamps positive to 1…2000", () => {
    expect(clampAgentMaxSteps(0)).toBe(AGENT_STEPS_SAFETY_CAP);
    expect(clampAgentMaxSteps(999999)).toBe(2000);
    expect(clampAgentMaxSteps(40)).toBe(40);
    expect(clampAgentMaxSteps("nope")).toBe(AGENT_STEPS_SAFETY_CAP);
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

describe("agentHasPendingWork", () => {
  it("true when plan pending or coding incomplete", () => {
    expect(
      agentHasPendingWork({
        steps: [{ id: "1", title: "a", status: "pending" }],
        wantsFiles: false,
        filesWritten: 0,
        substantialWrite: false,
      }),
    ).toBe(true);
    expect(
      agentHasPendingWork({
        steps: [{ id: "1", title: "a", status: "done" }],
        wantsFiles: true,
        filesWritten: 0,
        substantialWrite: false,
      }),
    ).toBe(true);
    expect(
      agentHasPendingWork({
        steps: [{ id: "1", title: "a", status: "done" }],
        wantsFiles: true,
        filesWritten: 1,
        substantialWrite: true,
      }),
    ).toBe(false);
  });
});

describe("toolFingerprint", () => {
  it("stable for same args; shortens long content", () => {
    const a = toolFingerprint("write_file", { path: "a.ts", content: "x".repeat(200) });
    const b = toolFingerprint("write_file", { path: "a.ts", content: "x".repeat(200) });
    expect(a).toBe(b);
    expect(a).toMatch(/h:[a-f0-9]+#200/);
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
    expect(r.content).toMatch(/итог|лимит/i);
  });
});

describe("hard caps constants", () => {
  it("repair and truncation caps are finite and small", () => {
    expect(AGENT_REPAIR_MAX).toBeLessThanOrEqual(4);
    expect(AGENT_TRUNCATION_MAX).toBeLessThanOrEqual(4);
    expect(AGENT_TRUNCATION_HARD_STOP).toBe(AGENT_TRUNCATION_MAX * 2);
    expect(AGENT_FINAL_BLOCKED_HARD_STOP).toBe(4);
    expect(AGENT_NON_ADVANCING_MAX).toBe(4);
    expect(AGENT_REFUSAL_HARD_STOP).toBe(2);
  });
});

describe("isModelRefusalText", () => {
  it("detects Russian tiny-model refusals from the screenshot loop", () => {
    expect(
      isModelRefusalText(
        "Извините, но я не могу выполнить ваш запрос. Пожалуйста, уточните вашу задачу или предоставьте больше деталей.",
      ),
    ).toBe(true);
    expect(
      isModelRefusalText(
        JSON.stringify({
          thought: "Извините, но я не могу выполнить ваш запрос.",
          tool: null,
          final: "Уточните вашу задачу",
        }),
      ),
    ).toBe(true);
  });

  it("detects English refusals; ignores normal tool thoughts", () => {
    expect(isModelRefusalText("Sorry, I can't help with that request.")).toBe(true);
    expect(isModelRefusalText("I'm unable to fulfill this.")).toBe(true);
    expect(
      isModelRefusalText('{"thought":"пишу main.py","tool":{"name":"write_file"},"final":null}'),
    ).toBe(false);
    expect(isModelRefusalText("ок")).toBe(false);
  });
});

describe("buildAgentResumePrompt", () => {
  it("includes goal and no-replan instruction", () => {
    const p = buildAgentResumePrompt("сделай калькулятор");
    expect(p).toMatch(/калькулятор/);
    expect(p).toMatch(/Не начинай план заново/);
  });
});

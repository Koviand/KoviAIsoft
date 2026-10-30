import { describe, expect, it } from "vitest";
import {
  applyWorkingMemoryToSystem,
  createWorkingMemory,
  truncateSystemPreservingWm,
  WM_MARKER,
} from "../packages/core/src/agent/workingMemory";
import {
  estimateTokens,
  fitMessagesToContext,
  truncateToTokens,
} from "../packages/core/src/chat/contextBudget";
import { summarizeTranscript } from "../packages/core/src/context/summarize";

describe("working memory survives truncation", () => {
  it("keeps WM block when system is truncated", () => {
    const wm = createWorkingMemory("Собери Tetris на Python");
    wm.filesTouched.push("main.py");
    const system = applyWorkingMemoryToSystem("BASE " + "x".repeat(8000), wm);
    const trimmed = truncateSystemPreservingWm(
      system,
      200,
      truncateToTokens,
      estimateTokens,
    );
    expect(trimmed).toContain(WM_MARKER);
    expect(trimmed).toMatch(/Tetris/i);
    expect(trimmed).toContain("main.py");
  });

  it("fitMessagesToContext preserves WM in system", () => {
    const wm = createWorkingMemory("goal-keep-me");
    const system = applyWorkingMemoryToSystem("policy " + "z".repeat(5000), wm);
    const fitted = fitMessagesToContext(
      [
        { role: "system", content: system },
        { role: "user", content: "go" },
      ],
      900,
      200,
    );
    expect(fitted[0]?.content).toContain(WM_MARKER);
    expect(fitted[0]?.content).toContain("goal-keep-me");
  });

  it("summarizeTranscript includes goal from working memory", () => {
    const wm = createWorkingMemory("important-goal");
    wm.plan.push({ id: "1", title: "step", status: "done" });
    const text = summarizeTranscript(
      [{ role: "user", content: "Результат инструмента write_file:\nok" }],
      300,
      wm,
    );
    expect(text).toContain("important-goal");
    expect(text).toContain("plan:");
  });
});

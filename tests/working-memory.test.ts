import { describe, expect, it } from "vitest";
import {
  applyWorkingMemoryToSystem,
  createWorkingMemory,
  emergencyShrinkTranscript,
  formatWorkingMemory,
  rememberToolError,
  rememberToolSuccess,
  updatePlanMemory,
} from "../packages/core/src/agent/workingMemory";

describe("agent working memory", () => {
  it("formats goal/plan/files for system injection", () => {
    const wm = createWorkingMemory("Сделай игру Tetris на Python");
    updatePlanMemory(wm, [
      { id: "1", title: "создать main.py", status: "done" },
      { id: "2", title: "добавить UI", status: "pending" },
    ]);
    rememberToolSuccess(wm, "write_file", { path: "C:\\proj\\main.py" }, "Written 1200 chars to C:\\proj\\main.py");
    const text = formatWorkingMemory(wm);
    expect(text).toContain("Working memory");
    expect(text).toMatch(/Tetris/i);
    expect(text).toContain("main.py");
    expect(text).toContain("[done]");
  });

  it("replaces previous working-memory block in system prompt", () => {
    const wm = createWorkingMemory("goal-a");
    const once = applyWorkingMemoryToSystem("BASE SYSTEM", wm);
    wm.goal = "goal-b";
    const twice = applyWorkingMemoryToSystem(once, wm);
    expect(twice.match(/Working memory/g)?.length).toBe(1);
    expect(twice).toContain("goal-b");
    expect(twice).not.toContain("goal-a");
    expect(twice.startsWith("BASE SYSTEM")).toBe(true);
  });

  it("emergency shrink keeps system and summarizes dropped turns", () => {
    const msgs = [
      { role: "system", content: "SYS\n\n# Working memory\ngoal: keep-me" },
      { role: "user", content: "old-1" },
      { role: "assistant", content: "old-2" },
      { role: "user", content: "old-3" },
      { role: "assistant", content: "recent-a" },
      { role: "user", content: "recent-b" },
    ];
    const shrunk = emergencyShrinkTranscript(msgs, 2, (old) =>
      `# summary\n${old.map((m) => m.content).join("|")}`,
    );
    expect(shrunk[0]?.role).toBe("system");
    expect(shrunk[0]?.content).toContain("keep-me");
    expect(shrunk.some((m) => m.content.includes("summary"))).toBe(true);
    expect(shrunk[shrunk.length - 1]?.content).toBe("recent-b");
    expect(shrunk.length).toBeLessThan(msgs.length);
  });

  it("records tool errors", () => {
    const wm = createWorkingMemory("x");
    rememberToolError(wm, "run_terminal", "cwd не существует: C:\\\\bad");
    expect(wm.lastError).toMatch(/cwd/);
    expect(wm.notes.some((n) => /error run_terminal/.test(n))).toBe(true);
  });
});

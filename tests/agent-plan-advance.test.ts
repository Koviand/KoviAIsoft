import { describe, expect, it } from "vitest";
import {
  currentPlanStep,
  defaultCodingPlan,
  isSoftResumeGoal,
  markCurrentPlanDone,
  shouldAdvancePlanOnTool,
} from "../packages/core/src/agent/planner";
import { toolFingerprint } from "../packages/core/src/agent/finishPolicy";
import { isValidAgentAction, parseAgentAction } from "../packages/core/src/agent/parseAction";
import {
  applyTextReplaceHunks,
  normalizePatchHunks,
} from "../packages/core/src/tools/textReplace";

describe("shouldAdvancePlanOnTool", () => {
  it("advances write step on write_file", () => {
    const step = { id: "1", title: "Создать основной файл", status: "pending" as const };
    expect(
      shouldAdvancePlanOnTool(step, "write_file", { path: "tetris/main.py", content: "x" }),
    ).toBe(true);
  });

  it("does not advance write step on unrelated run_terminal", () => {
    const step = { id: "1", title: "Создать основной файл", status: "pending" as const };
    expect(shouldAdvancePlanOnTool(step, "run_terminal", { command: "dir" })).toBe(false);
  });

  it("advances run step only on run_terminal", () => {
    const step = { id: "3", title: "Проверить запуск (run_terminal)", status: "pending" as const };
    expect(shouldAdvancePlanOnTool(step, "run_terminal", { command: "python main.py" })).toBe(
      true,
    );
    expect(
      shouldAdvancePlanOnTool(step, "write_file", { path: "main.py", content: "x" }),
    ).toBe(false);
  });

  it("does not advance final-ish steps via tools", () => {
    const step = { id: "5", title: "Краткий итог пользователю (final)", status: "pending" as const };
    expect(
      shouldAdvancePlanOnTool(step, "write_file", { path: "x.py", content: "hi" }),
    ).toBe(false);
  });

  it("markCurrentPlanDone only after matching tool", () => {
    let steps = defaultCodingPlan();
    const cur = currentPlanStep(steps)!;
    expect(shouldAdvancePlanOnTool(cur, "run_terminal", { command: "echo" })).toBe(false);
    expect(shouldAdvancePlanOnTool(cur, "write_file", { path: "a.py", content: "1" })).toBe(true);
    steps = markCurrentPlanDone(steps, "write_file");
    expect(steps[0]!.status).toBe("done");
  });
});

describe("toolFingerprint", () => {
  it("distinguishes different long contents of same length/prefix", () => {
    const prefix = "x".repeat(80);
    const a = toolFingerprint("write_file", {
      path: "a.ts",
      content: prefix + "AAA" + "y".repeat(50),
    });
    const b = toolFingerprint("write_file", {
      path: "a.ts",
      content: prefix + "BBB" + "y".repeat(50),
    });
    expect(a).not.toBe(b);
    expect(a).toContain("h:");
  });

  it("stable for identical args", () => {
    const content = "hello world ".repeat(20);
    const a = toolFingerprint("write_file", { path: "a.ts", content });
    const b = toolFingerprint("write_file", { path: "a.ts", content });
    expect(a).toBe(b);
  });
});

describe("isSoftResumeGoal", () => {
  it("keeps plan on exact goal or continue cue with unfinished plan", () => {
    expect(isSoftResumeGoal("сделай тетрис", "сделай тетрис")).toBe(true);
    expect(
      isSoftResumeGoal("продолжи", "сделай тетрис", { hasUnfinishedFrozenPlan: true }),
    ).toBe(true);
  });

  it("does not soft-resume on token overlap; continue cue always keeps notes", () => {
    expect(isSoftResumeGoal("добавь счёт в tetris", "сделай tetris игру")).toBe(false);
    // Explicit «продолжи» soft-resumes even without unfinished plan (avoid wipe notes).
    expect(
      isSoftResumeGoal("продолжи", "сделай тетрис", { hasUnfinishedFrozenPlan: false }),
    ).toBe(true);
  });

  it("resets on unrelated goal", () => {
    expect(isSoftResumeGoal("напиши калькулятор", "сделай тетрис")).toBe(false);
  });
});

describe("kind-based advance", () => {
  it("advances edit kind only on write/patch", () => {
    const step = {
      id: "1",
      title: "Do stuff",
      status: "pending" as const,
      kind: "edit" as const,
    };
    expect(shouldAdvancePlanOnTool(step, "write_file", { path: "a.py" })).toBe(true);
    expect(shouldAdvancePlanOnTool(step, "run_terminal", { command: "x" })).toBe(false);
  });

  it("advances explore kind on read_file", () => {
    const step = {
      id: "1",
      title: "Look around",
      status: "pending" as const,
      kind: "explore" as const,
    };
    expect(shouldAdvancePlanOnTool(step, "read_file", { path: "a.py" })).toBe(true);
  });
});

describe("plan phase validation", () => {
  it("rejects tool-only JSON in plan phase", () => {
    const raw = '{"thought":"t","tool":{"name":"list_dir","args":{"path":"."}},"final":null}';
    expect(parseAgentAction(raw, "plan")).toBeNull();
    expect(
      isValidAgentAction(
        { thought: "t", tool: { name: "list_dir", args: { path: "." } }, final: null },
        "plan",
      ),
    ).toBe(false);
  });

  it("accepts plan array in plan phase", () => {
    const raw =
      '{"thought":"t","plan":[{"id":"1","title":"a"},{"id":"2","title":"b"},{"id":"3","title":"c"}],"tool":null,"final":null}';
    expect(parseAgentAction(raw, "plan")?.plan?.length).toBe(3);
  });
});

describe("multi-hunk patch", () => {
  it("applies replacements sequentially", () => {
    const next = applyTextReplaceHunks("foo bar baz", [
      { oldText: "foo", newText: "FOO" },
      { oldText: "baz", newText: "BAZ" },
    ]);
    expect(next).toBe("FOO bar BAZ");
  });

  it("normalizes replacements array", () => {
    const hunks = normalizePatchHunks({
      replacements: [
        { oldText: "a", newText: "A" },
        { oldText: "b", newText: "B" },
      ],
    });
    expect(hunks).toHaveLength(2);
  });
});

import { describe, expect, it } from "vitest";
import {
  detectAgentTask,
  detectCodingTask,
  detectToolAction,
} from "../packages/core/src/agent/intent";

describe("agent intent heuristics", () => {
  it("detects coding tasks that must force write_file", () => {
    expect(detectCodingTask("Я хочу чтобы ты написал игру Tetris на Python")).toBe(true);
    expect(detectCodingTask("implement tetris in python")).toBe(true);
    expect(detectCodingTask("перепиши auth модуль")).toBe(true);
    expect(detectCodingTask("сделай игру тетрис")).toBe(true);
    expect(detectCodingTask("привет")).toBe(false);
  });

  it("detects shell/tool actions", () => {
    expect(detectToolAction("запусти npm test", true)).toBe(true);
    expect(detectToolAction("run pytest", false)).toBe(true);
    expect(detectToolAction("list_dir в проекте", false)).toBe(true);
    expect(detectToolAction("привет", true)).toBe(false);
  });

  it("routes combined agent tasks", () => {
    expect(detectAgentTask("fix bug in main.py", { projectRoot: "C:\\p" })).toBe(true);
    expect(detectAgentTask("просто поговорим", { projectRoot: "C:\\p" })).toBe(false);
  });
});

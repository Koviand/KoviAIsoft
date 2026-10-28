import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertAllowedPath,
  isPathInside,
  riskForTool,
} from "../packages/core/src/tools/sandbox";

describe("sandbox", () => {
  const root = "C:\\Models\\LFM\\project";

  it("detects path containment", () => {
    expect(isPathInside(path.join(root, "a.ts"), root)).toBe(true);
    expect(isPathInside("C:\\Windows\\System32", root)).toBe(false);
  });

  it("enforces project mode", () => {
    expect(() =>
      assertAllowedPath(path.join(root, "x.txt"), "project", root),
    ).not.toThrow();
    expect(() => assertAllowedPath("C:\\Temp\\x.txt", "project", root)).toThrow();
    expect(() => assertAllowedPath("C:\\Temp\\x.txt", "project", null)).toThrow();
  });

  it("classifies tool risk", () => {
    expect(riskForTool("read_file", { path: "a" })).toBe("low");
    expect(riskForTool("write_file", { path: "C:\\Models\\LFM\\a.txt" })).toBe("medium");
    expect(riskForTool("run_terminal", { command: "dir" })).toBe("high");
  });
});

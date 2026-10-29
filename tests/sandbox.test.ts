import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  approvalRememberKey,
  assertAllowedPath,
  assertTerminalCwd,
  isPathInside,
  riskForTool,
} from "../packages/core/src/tools/sandbox";

describe("sandbox", () => {
  const root = "C:\\Models\\LFM\\project";
  const models = "C:\\Models\\LFM";

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

  it("enforces disk mode against modelRoots + project", () => {
    expect(() =>
      assertAllowedPath(path.join(models, "a.gguf"), "disk", root, [models]),
    ).not.toThrow();
    expect(() =>
      assertAllowedPath(path.join(root, "src\\a.ts"), "disk", root, [models]),
    ).not.toThrow();
    expect(() => assertAllowedPath("C:\\Temp\\x.txt", "disk", root, [models])).toThrow(
      /вне разрешённых/,
    );
    expect(() => assertAllowedPath("C:\\Temp\\x.txt", "disk", null, [])).toThrow(
      /задайте папки/,
    );
  });

  it("scopes remember keys by path and skips terminal", () => {
    expect(approvalRememberKey("run_terminal", { command: "dir", cwd: root }, root)).toBeNull();
    expect(approvalRememberKey("browser_click", { selector: "a" })).toBeNull();
    const key = approvalRememberKey(
      "write_file",
      { path: path.join(root, "a.txt"), content: "x" },
      root,
    );
    expect(key).toMatch(/^write_file::/);
    expect(
      approvalRememberKey(
        "write_file",
        { path: path.join(root, "b.txt"), content: "y" },
        root,
      ),
    ).not.toBe(key);
  });

  it("classifies tool risk", () => {
    expect(riskForTool("read_file", { path: "a" })).toBe("low");
    expect(riskForTool("write_file", { path: "C:\\Models\\LFM\\a.txt" })).toBe("medium");
    expect(riskForTool("run_terminal", { command: "dir" })).toBe("high");
  });

  it("allows disk-mode terminal outside modelRoots but not System32", () => {
    expect(() =>
      assertTerminalCwd("C:\\Users\\Kovi\\Documents\\App", "disk", null),
    ).not.toThrow();
    expect(() => assertTerminalCwd("C:\\Windows\\System32", "disk", root)).toThrow();
  });
});


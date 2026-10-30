import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertNotReservedWinName,
  collapseOverEscapedWinPath,
  isDangerousSystemDir,
  resolveAgentPath,
} from "../packages/core/src/tools/sandbox";

describe("Windows agent path resolution", () => {
  const root = "C:\\Users\\Kovi\\proj";

  it("collapses over-escaped drive paths from model JSON", () => {
    // After JSON.parse of "C:\\\\Users\\\\Kovi\\\\proj" the string is C:\\Users\\Kovi\\proj
    const over = "C:\\\\Users\\\\Kovi\\\\proj";
    expect(collapseOverEscapedWinPath(over).toLowerCase()).toBe(
      "C:\\Users\\Kovi\\proj".toLowerCase(),
    );
    expect(resolveAgentPath(over, root).toLowerCase()).toBe(
      path.resolve(root).toLowerCase(),
    );
    // Correct single-backslash paths stay intact
    expect(collapseOverEscapedWinPath("C:\\Users\\Kovi\\proj").toLowerCase()).toBe(
      "C:\\Users\\Kovi\\proj".toLowerCase(),
    );
  });

  it("resolves relative and POSIX paths against projectRoot", () => {
    expect(resolveAgentPath("src\\a.ts", root).toLowerCase()).toContain("src");
    expect(resolveAgentPath("src/a.ts", root).toLowerCase()).toContain("src");
    const posix = resolveAgentPath("/tmp/work", root);
    expect(posix.toLowerCase()).toContain(path.join("proj", "tmp", "work").toLowerCase());
    expect(posix.toLowerCase()).not.toMatch(/^\\tmp/);
  });

  it("maps /C:/ and project-mirrored POSIX without nesting Users under project", () => {
    if (process.platform !== "win32") return;
    expect(resolveAgentPath("/C:/Users/Kovi/proj/a.ts", root).toLowerCase()).toBe(
      path.resolve("C:\\Users\\Kovi\\proj\\a.ts").toLowerCase(),
    );
    const mirrored = resolveAgentPath("/Users/Kovi/proj/src/main.py", root);
    expect(mirrored.toLowerCase()).toBe(path.resolve(root, "src", "main.py").toLowerCase());
  });

  it("blank cwd becomes projectRoot when allowed", () => {
    expect(
      resolveAgentPath("", root, { allowBlankAsProject: true }).toLowerCase(),
    ).toBe(path.resolve(root).toLowerCase());
  });

  it("blocks reserved device names and system dirs", () => {
    expect(() => assertNotReservedWinName("C:\\proj\\nul.txt")).toThrow(/Запрещённое/);
    expect(isDangerousSystemDir("C:\\Windows")).toBe(true);
    expect(isDangerousSystemDir("C:\\Windows\\System32")).toBe(true);
    expect(isDangerousSystemDir("C:\\")).toBe(true);
    expect(isDangerousSystemDir("C:\\Users\\Kovi\\proj")).toBe(false);
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultSettings } from "../packages/shared/src/types";
import { assertTerminalCwd } from "../packages/core/src/tools/sandbox";
import {
  adaptCommandForWindows,
  collapseOverEscapedWinPathsInCommand,
  isBlankCwd,
  resolveTerminalCwd,
  runTerminal,
} from "../packages/core/src/tools/terminal";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Windows agent shell helpers", () => {
  it("detects blank cwd placeholders from the model", () => {
    expect(isBlankCwd(undefined)).toBe(true);
    expect(isBlankCwd("undefined")).toBe(true);
    expect(isBlankCwd("null")).toBe(true);
    expect(isBlankCwd("")).toBe(true);
    expect(isBlankCwd("C:\\proj")).toBe(false);
  });

  it("resolves empty cwd to projectRoot and normalizes slashes", () => {
    const root = "C:\\Users\\Kovi\\proj";
    expect(resolveTerminalCwd("", root).toLowerCase()).toBe(path.resolve(root).toLowerCase());
    expect(resolveTerminalCwd("src/app", root).toLowerCase()).toContain("src");
    expect(resolveTerminalCwd("C:/Temp/work", root).toLowerCase()).toContain("temp");
    expect(() => resolveTerminalCwd("", null)).toThrow(/папк/);
  });

  it("collapses over-escaped drive paths inside commands", () => {
    const fixed = collapseOverEscapedWinPathsInCommand("dir C:\\\\Users\\\\Kovi\\\\proj");
    expect(fixed.toLowerCase()).toBe("dir C:\\Users\\Kovi\\proj".toLowerCase());
    expect(collapseOverEscapedWinPathsInCommand("echo hi")).toBe("echo hi");
    expect(collapseOverEscapedWinPathsInCommand("type C:\\Users\\a.txt").toLowerCase()).toBe(
      "type C:\\Users\\a.txt".toLowerCase(),
    );
  });

  it("resolves over-escaped cwd the same as a normal path", () => {
    const root = "C:\\Users\\Kovi\\proj";
    const over = "C:\\\\Users\\\\Kovi\\\\proj";
    expect(resolveTerminalCwd(over, root).toLowerCase()).toBe(path.resolve(root).toLowerCase());
  });

  it("adapts common unix one-liners to cmd", () => {
    expect(adaptCommandForWindows("pwd")).toBe("cd");
    expect(adaptCommandForWindows("ls")).toBe("dir /b");
    expect(adaptCommandForWindows("cat readme.txt")).toBe("type readme.txt");
    expect(adaptCommandForWindows("rm -rf build")).toMatch(/^rmdir \/s \/q/);
    expect(adaptCommandForWindows("which node")).toMatch(/^where/);
    expect(adaptCommandForWindows("cp a.txt b.txt")).toMatch(/^copy \/y/);
    expect(adaptCommandForWindows("npm test")).toBe("npm test");
    expect(adaptCommandForWindows("powershell Get-Date")).toBe("powershell Get-Date");
    expect(() => adaptCommandForWindows("rm -rf .")).toThrow(/Опасная/);
  });

  it("blocks shell cwd in Windows system trees", () => {
    expect(() => assertTerminalCwd("C:\\Windows\\System32", "disk", null)).toThrow(
      /системн/,
    );
    expect(() => assertTerminalCwd("C:\\", "disk", null)).toThrow(/системн/);
    const proj = "C:\\Users\\Kovi\\Documents\\MyApp";
    expect(() => assertTerminalCwd(proj, "project", proj)).not.toThrow();
    expect(() => assertTerminalCwd("C:\\Temp\\other", "project", proj)).toThrow(/проекта/);
  });
});

describe("runTerminal on Windows", () => {
  it("runs echo and returns exit 0 with cwd default", async () => {
    if (process.platform !== "win32") return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kovi-shell-"));
    temps.push(dir);
    const settings = createDefaultSettings(dir);
    settings.projectRoot = dir;
    settings.fileAccessMode = "disk";

    const out = await runTerminal("echo hello-kovi", "", settings);
    expect(out).toMatch(/exit: 0/);
    expect(out).toMatch(/hello-kovi/i);
    expect(out).toMatch(/cwd:/i);
  });

  it("accepts over-escaped cwd from model JSON", async () => {
    if (process.platform !== "win32") return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kovi-shell-"));
    temps.push(dir);
    const settings = createDefaultSettings(dir);
    settings.projectRoot = dir;
    settings.fileAccessMode = "disk";
    // Simulate path after JSON.parse of "C:\\\\…\\\\…"
    const overEscaped = dir.replace(/\\/g, "\\\\");
    const out = await runTerminal("echo ok-escape", overEscaped, settings);
    expect(out).toMatch(/exit: 0/);
    expect(out).toMatch(/ok-escape/i);
  });

  it("returns non-zero exit instead of throwing", async () => {
    if (process.platform !== "win32") return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kovi-shell-"));
    temps.push(dir);
    const settings = createDefaultSettings(dir);
    settings.projectRoot = dir;
    settings.fileAccessMode = "project";

    const out = await runTerminal("cmd /c exit 7", dir, settings);
    expect(out).toMatch(/exit: 7/);
  });

  it("maps ls to dir and lists a file", async () => {
    if (process.platform !== "win32") return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kovi-shell-"));
    temps.push(dir);
    fs.writeFileSync(path.join(dir, "marker.txt"), "x", "utf8");
    const settings = createDefaultSettings(dir);
    settings.projectRoot = dir;
    settings.fileAccessMode = "project";

    const out = await runTerminal("ls", dir, settings);
    expect(out).toMatch(/exit: 0/);
    expect(out).toMatch(/marker\.txt/i);
  });
});

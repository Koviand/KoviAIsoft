import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultSettings } from "../packages/shared/src/types";
import { writeFileAtomic } from "../packages/core/src/fsAtomic";
import { applyPatchTool, writeFileTool } from "../packages/core/src/tools/files";
import { applyTextReplace } from "../packages/core/src/tools/textReplace";
import { resolveAgentPath } from "../packages/core/src/tools/sandbox";
import { adaptCommandForWindows, isShellFileWriteAttempt } from "../packages/core/src/tools/terminal";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Windows path mapping for agent writes", () => {
  const root = "C:\\Users\\Kovi\\Documents\\AITEst";

  it("maps /C:/… and MSYS paths to Windows absolute", () => {
    if (process.platform !== "win32") return;
    expect(resolveAgentPath("/C:/Users/Kovi/Documents/AITEst/a.py", root).toLowerCase()).toBe(
      path.resolve("C:\\Users\\Kovi\\Documents\\AITEst\\a.py").toLowerCase(),
    );
    expect(resolveAgentPath("/c/Users/Kovi/Documents/AITEst/b.py", root).toLowerCase()).toContain(
      "aitest",
    );
  });

  it("maps POSIX path that mirrors projectRoot without duplicating folders", () => {
    if (process.platform !== "win32") return;
    const mapped = resolveAgentPath(
      "/Users/Kovi/Documents/AITEst/tetris_game/main.py",
      root,
    );
    expect(mapped.toLowerCase()).toBe(
      path.resolve(root, "tetris_game", "main.py").toLowerCase(),
    );
    expect(mapped.toLowerCase()).not.toContain(
      path.join("aitest", "users", "kovi").toLowerCase(),
    );
  });

  it("still treats unrelated POSIX abs as project-relative", () => {
    if (process.platform !== "win32") return;
    const mapped = resolveAgentPath("/tmp/work/x.py", root);
    expect(mapped.toLowerCase()).toBe(path.resolve(root, "tmp", "work", "x.py").toLowerCase());
  });
});

describe("applyTextReplace", () => {
  it("does not interpret $& in replacement", () => {
    const next = applyTextReplace("price is X", "X", "$& and $$");
    expect(next).toBe("price is $& and $$");
  });

  it("matches LF oldText against CRLF file", () => {
    const file = "line1\r\nline2\r\nline3\r\n";
    const next = applyTextReplace(file, "line2\n", "LINE2\n");
    expect(next).toBe("line1\r\nLINE2\r\nline3\r\n");
  });
});

describe("write_file / apply_patch on disk", () => {
  it("writes nested path and patches literally", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kovi-fs-"));
    temps.push(dir);
    const settings = createDefaultSettings(dir);
    settings.projectRoot = dir;
    settings.fileAccessMode = "project";

    const rel = path.join("tetris_game", "main.py");
    const out = await writeFileTool(rel, "print('hi')\nvalue = '$&'\n", settings);
    expect(out).toMatch(/Written/);
    const abs = path.join(dir, rel);
    expect(fs.readFileSync(abs, "utf8")).toContain("$&");

    await applyPatchTool(rel, "print('hi')", "print('tetris')", settings);
    expect(fs.readFileSync(abs, "utf8")).toContain("print('tetris')");
    expect(fs.readFileSync(abs, "utf8")).toContain("$&");
  });

  it("rejects empty write_file content", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kovi-fs-"));
    temps.push(dir);
    const settings = createDefaultSettings(dir);
    settings.projectRoot = dir;
    settings.fileAccessMode = "project";
    await expect(writeFileTool("a.py", "", settings)).rejects.toThrow(/пустой content/);
  });

  it("atomic replace keeps target if copy works", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kovi-atomic-"));
    temps.push(dir);
    const target = path.join(dir, "game.py");
    fs.writeFileSync(target, "old", "utf8");
    await writeFileAtomic(target, "new-content-safe");
    expect(fs.readFileSync(target, "utf8")).toBe("new-content-safe");
    const leftovers = fs.readdirSync(dir).filter((n) => n.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });
});

describe("shell file-write guard", () => {
  it("detects heredoc and redirect attempts", () => {
    expect(isShellFileWriteAttempt("cat > main.py <<EOF\nprint(1)\nEOF")).toBe(true);
    expect(isShellFileWriteAttempt("echo print(1) > game.py")).toBe(true);
    expect(isShellFileWriteAttempt("dir")).toBe(false);
    expect(() => adaptCommandForWindows("cat > x.py <<EOF\nx\nEOF")).toThrow(/write_file/);
  });
});

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AppSettings } from "@kovi/shared";
import { assertAllowedPath } from "./sandbox.js";

const execFileAsync = promisify(execFile);

/** ripgrep exits with 1 when there are no matches (not a hard failure). */
export function isRipgrepNoMatch(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string | number; status?: number };
  return e.code === 1 || e.status === 1;
}

export async function listDir(dirPath: string, settings: AppSettings): Promise<string> {
  assertAllowedPath(dirPath, settings.fileAccessMode, settings.projectRoot, settings.modelRoots);
  const entries = await fsp.readdir(dirPath, { withFileTypes: true });
  return entries
    .map((e) => `${e.isDirectory() ? "dir" : "file"}\t${e.name}`)
    .join("\n");
}

export async function readFileTool(
  filePath: string,
  settings: AppSettings,
  maxBytes = 200_000,
): Promise<string> {
  assertAllowedPath(filePath, settings.fileAccessMode, settings.projectRoot, settings.modelRoots);
  const st = await fsp.stat(filePath);
  if (st.size > maxBytes) {
    const buf = Buffer.alloc(maxBytes);
    const fh = await fsp.open(filePath, "r");
    await fh.read(buf, 0, maxBytes, 0);
    await fh.close();
    return buf.toString("utf8") + `\n\n[truncated, file size ${st.size} bytes]`;
  }
  return fsp.readFile(filePath, "utf8");
}

export async function writeFileTool(
  filePath: string,
  content: string,
  settings: AppSettings,
): Promise<string> {
  assertAllowedPath(filePath, settings.fileAccessMode, settings.projectRoot, settings.modelRoots);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, content, "utf8");
  return `Written ${content.length} chars to ${filePath}`;
}

export async function applyPatchTool(
  filePath: string,
  oldText: string,
  newText: string,
  settings: AppSettings,
): Promise<string> {
  const current = await readFileTool(filePath, settings);
  if (!current.includes(oldText)) {
    throw new Error("Фрагмент для замены не найден");
  }
  const next = current.replace(oldText, newText);
  await writeFileTool(filePath, next, settings);
  return `Patched ${filePath}`;
}

export async function deletePathTool(target: string, settings: AppSettings): Promise<string> {
  assertAllowedPath(target, settings.fileAccessMode, settings.projectRoot, settings.modelRoots);
  const st = await fsp.stat(target);
  if (st.isDirectory()) {
    await fsp.rm(target, { recursive: true, force: true });
  } else {
    await fsp.unlink(target);
  }
  return `Deleted ${target}`;
}

export async function searchFiles(
  query: string,
  root: string,
  settings: AppSettings,
): Promise<string> {
  assertAllowedPath(root, settings.fileAccessMode, settings.projectRoot, settings.modelRoots);
  // Prefer ripgrep if available (exit code 1 = no matches)
  try {
    const { stdout } = await execFileAsync(
      "rg",
      ["-n", "--max-count", "50", "--glob", "!node_modules", query, root],
      { windowsHide: true, timeout: 15000, maxBuffer: 2 * 1024 * 1024 },
    );
    return stdout || "(нет совпадений)";
  } catch (err) {
    if (isRipgrepNoMatch(err)) {
      const e = err as { stdout?: string };
      return e.stdout || "(нет совпадений)";
    }
    // fallback naive walk (rg missing or other failure)
    const hits: string[] = [];
    const stack = [root];
    while (stack.length && hits.length < 50) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (e.isFile()) {
          try {
            const text = fs.readFileSync(full, "utf8");
            const idx = text.indexOf(query);
            if (idx >= 0) {
              const line = text.slice(0, idx).split(/\r?\n/).length;
              hits.push(`${full}:${line}`);
            }
          } catch {
            // binary/skip
          }
        }
      }
    }
    return hits.join("\n") || "(нет совпадений)";
  }
}

export async function runTerminal(
  command: string,
  cwd: string,
  settings: AppSettings,
): Promise<string> {
  assertAllowedPath(cwd, settings.fileAccessMode, settings.projectRoot, settings.modelRoots);
  const { stdout, stderr } = await execFileAsync(
    process.env.ComSpec || "cmd.exe",
    ["/d", "/s", "/c", command],
    {
      cwd,
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  return [`$ ${command}`, stdout, stderr].filter(Boolean).join("\n");
}

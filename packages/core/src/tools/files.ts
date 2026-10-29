import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AppSettings } from "@kovi/shared";
import { writeFileAtomic } from "../fsAtomic.js";
import {
  assertAllowedPath,
  isPathInside,
  normalizePath,
  realPathSafe,
  resolveAgentPath,
} from "./sandbox.js";
import { applyTextReplace } from "./textReplace.js";

export { applyTextReplace } from "./textReplace.js";

export { runTerminal } from "./terminal.js";

const execFileAsync = promisify(execFile);

/** ripgrep exits with 1 when there are no matches (not a hard failure). */
export function isRipgrepNoMatch(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string | number; status?: number };
  return e.code === 1 || e.status === 1;
}

function resolveToolPath(raw: string, settings: AppSettings): string {
  const resolved = resolveAgentPath(raw, settings.projectRoot);
  return assertAllowedPath(
    resolved,
    settings.fileAccessMode,
    settings.projectRoot,
    settings.modelRoots,
  );
}

export async function listDir(dirPath: string, settings: AppSettings): Promise<string> {
  const resolved = resolveToolPath(dirPath, settings);
  const entries = await fsp.readdir(resolved, { withFileTypes: true });
  return entries
    .map((e) => {
      const kind = e.isSymbolicLink()
        ? "link"
        : e.isDirectory()
          ? "dir"
          : "file";
      return `${kind}\t${e.name}`;
    })
    .join("\n");
}

export async function readFileTool(
  filePath: string,
  settings: AppSettings,
  maxBytes = 200_000,
): Promise<string> {
  const resolved = resolveToolPath(filePath, settings);
  const st = await fsp.stat(resolved);
  if (st.size > maxBytes) {
    const buf = Buffer.alloc(maxBytes);
    const fh = await fsp.open(resolved, "r");
    await fh.read(buf, 0, maxBytes, 0);
    await fh.close();
    return buf.toString("utf8") + `\n\n[truncated, file size ${st.size} bytes]`;
  }
  return fsp.readFile(resolved, "utf8");
}

/** Full-file read for patching (no truncation marker). */
async function readFileRawForPatch(
  filePath: string,
  settings: AppSettings,
  maxBytes = 2_000_000,
): Promise<{ path: string; text: string }> {
  const resolved = resolveToolPath(filePath, settings);
  const st = await fsp.stat(resolved);
  if (st.size > maxBytes) {
    throw new Error(`Файл слишком большой для apply_patch (${st.size} bytes)`);
  }
  return { path: resolved, text: await fsp.readFile(resolved, "utf8") };
}

export async function writeFileTool(
  filePath: string,
  content: string,
  settings: AppSettings,
): Promise<string> {
  if (typeof content !== "string") {
    throw new Error("write_file: content должен быть строкой с полным текстом файла");
  }
  if (!content.length) {
    throw new Error("write_file: пустой content запрещён — передайте полный код файла");
  }
  const resolved = resolveToolPath(filePath, settings);
  await fsp.mkdir(path.dirname(resolved), { recursive: true });
  await writeFileAtomic(resolved, content);
  return `Written ${content.length} chars to ${resolved}`;
}

export async function applyPatchTool(
  filePath: string,
  oldText: string,
  newText: string,
  settings: AppSettings,
): Promise<string> {
  if (typeof oldText !== "string" || typeof newText !== "string") {
    throw new Error("apply_patch: oldText и newText должны быть строками");
  }
  const { path: resolved, text: current } = await readFileRawForPatch(filePath, settings);
  const next = applyTextReplace(current, oldText, newText);
  await writeFileAtomic(resolved, next);
  return `Patched ${resolved} (${current.length} → ${next.length} chars)`;
}

export async function deletePathTool(target: string, settings: AppSettings): Promise<string> {
  const resolved = resolveToolPath(target, settings);
  if (settings.projectRoot) {
    const root = normalizePath(settings.projectRoot);
    if (normalizePath(resolved).toLowerCase() === root.toLowerCase()) {
      throw new Error("Нельзя удалить корень проекта");
    }
    const rootReal = realPathSafe(root);
    const targetReal = realPathSafe(resolved);
    if (targetReal.toLowerCase() === rootReal.toLowerCase()) {
      throw new Error("Нельзя удалить корень проекта");
    }
  }

  let lst: fs.Stats;
  try {
    lst = await fsp.lstat(resolved);
  } catch {
    throw new Error(`Путь не найден: ${resolved}`);
  }

  if (lst.isSymbolicLink()) {
    await fsp.unlink(resolved);
    return `Deleted symlink ${resolved}`;
  }
  if (lst.isDirectory()) {
    // Avoid following junctions into outside trees: only allow if realpath stays inside policy.
    const real = realPathSafe(resolved);
    assertAllowedPath(
      real,
      settings.fileAccessMode,
      settings.projectRoot,
      settings.modelRoots,
    );
    if (settings.projectRoot && !isPathInside(real, settings.projectRoot)) {
      // disk mode may allow; project mode already enforced by assert
    }
    await fsp.rm(resolved, { recursive: true, force: true });
  } else {
    await fsp.unlink(resolved);
  }
  return `Deleted ${resolved}`;
}

export async function searchFiles(
  query: string,
  root: string,
  settings: AppSettings,
): Promise<string> {
  const resolvedRoot = resolveToolPath(root, settings);
  try {
    const { stdout } = await execFileAsync(
      "rg",
      [
        "-n",
        "-F",
        "--max-count",
        "50",
        "--glob",
        "!node_modules",
        "--glob",
        "!.git",
        query,
        resolvedRoot,
      ],
      { windowsHide: true, timeout: 15000, maxBuffer: 2 * 1024 * 1024 },
    );
    return stdout || "(нет совпадений)";
  } catch (err) {
    if (isRipgrepNoMatch(err)) {
      const e = err as { stdout?: string };
      return e.stdout || "(нет совпадений)";
    }
    const hits: string[] = [];
    const stack = [resolvedRoot];
    const visited = new Set<string>();
    while (stack.length && hits.length < 50) {
      const dir = stack.pop()!;
      let realDir: string;
      try {
        realDir = realPathSafe(dir).toLowerCase();
      } catch {
        continue;
      }
      if (visited.has(realDir)) continue;
      visited.add(realDir);
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        const full = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue;
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

import fs from "node:fs";
import path from "node:path";
import { shouldIgnoreDirName, isTextSourcePath } from "./ignore.js";

export interface ProjectMapOptions {
  maxEntries?: number;
  maxDepth?: number;
}

export interface ProjectMapResult {
  root: string;
  treeText: string;
  files: string[]; // relative posix-ish paths
  truncated: boolean;
}

/**
 * Compact project tree for LLM context (Cursor-style codebase map).
 */
export function buildProjectMap(
  projectRoot: string,
  opts: ProjectMapOptions = {},
): ProjectMapResult {
  const maxEntries = opts.maxEntries ?? 400;
  const maxDepth = opts.maxDepth ?? 6;
  const files: string[] = [];
  const lines: string[] = [];
  let truncated = false;

  const walk = (dir: string, depth: number, prefix: string): void => {
    if (truncated) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    for (const ent of entries) {
      if (truncated) return;
      if (ent.name === "." || ent.name === "..") continue;
      if (ent.isDirectory() && shouldIgnoreDirName(ent.name)) continue;
      if (ent.isSymbolicLink()) continue;

      const full = path.join(dir, ent.name);
      const rel = path.relative(projectRoot, full).split(path.sep).join("/");

      if (ent.isDirectory()) {
        if (files.length + lines.length >= maxEntries) {
          truncated = true;
          return;
        }
        lines.push(`${prefix}${ent.name}/`);
        if (depth < maxDepth) walk(full, depth + 1, `${prefix}  `);
        continue;
      }

      if (!ent.isFile()) continue;
      if (!isTextSourcePath(full)) continue;
      if (files.length >= maxEntries) {
        truncated = true;
        return;
      }
      files.push(rel);
      lines.push(`${prefix}${ent.name}`);
    }
  };

  walk(projectRoot, 0, "");
  const header = truncated
    ? `# Карта проекта (обрезана, показаны первые ${files.length} файлов)`
    : `# Карта проекта (${files.length} файлов)`;
  return {
    root: projectRoot,
    treeText: `${header}\n${lines.slice(0, maxEntries).join("\n")}`,
    files,
    truncated,
  };
}

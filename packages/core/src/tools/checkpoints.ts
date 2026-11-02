import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { AppSettings } from "@kovi/shared";
import { writeFileAtomic } from "../fsAtomic.js";
import { assertAllowedPath, resolveAgentPath } from "./sandbox.js";

export function checkpointsRoot(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), ".kovi", "checkpoints");
}

function assertUnderCheckpoints(projectRoot: string, cpAbs: string): void {
  const cpRoot = checkpointsRoot(projectRoot);
  const norm = path.resolve(cpAbs).toLowerCase();
  const root = cpRoot.toLowerCase();
  if (norm !== root && !norm.startsWith(root + path.sep.toLowerCase())) {
    throw new Error("Можно работать только с файлами в .kovi/checkpoints/");
  }
}

/**
 * Snapshot existing file before overwrite. Returns checkpoint abs path or null if no prior file.
 * Checkpoints live under .kovi/checkpoints (internal write — bypass agent write ban).
 */
export async function saveFileCheckpoint(opts: {
  projectRoot: string | null;
  targetAbs: string;
  runId: string;
}): Promise<string | null> {
  const { projectRoot, targetAbs, runId } = opts;
  if (!projectRoot || !runId) return null;
  if (!fs.existsSync(targetAbs) || !fs.statSync(targetAbs).isFile()) return null;

  const root = path.resolve(projectRoot);
  const rel = path.relative(root, targetAbs).replace(/\\/g, "/");
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;

  const dest = path.join(checkpointsRoot(root), runId, rel);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.copyFile(targetAbs, dest);
  return dest;
}

export async function restoreCheckpoint(opts: {
  projectRoot: string;
  checkpointAbsOrRel: string;
  settings: AppSettings;
}): Promise<string> {
  const root = path.resolve(opts.projectRoot);
  const cpRoot = checkpointsRoot(root);
  const cpAbs = path.isAbsolute(opts.checkpointAbsOrRel)
    ? path.resolve(opts.checkpointAbsOrRel)
    : path.resolve(root, opts.checkpointAbsOrRel);

  assertUnderCheckpoints(root, cpAbs);
  if (!fs.existsSync(cpAbs) || !fs.statSync(cpAbs).isFile()) {
    throw new Error(`Checkpoint не найден: ${cpAbs}`);
  }

  const rel = path.relative(cpRoot, cpAbs).replace(/\\/g, "/");
  const parts = rel.split("/");
  if (parts.length < 2) throw new Error("Некорректный checkpoint path");
  const fileRel = parts.slice(1).join("/");
  const target = path.join(root, fileRel);
  assertAllowedPath(
    target,
    opts.settings.fileAccessMode,
    opts.settings.projectRoot,
    opts.settings.modelRoots,
  );
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const content = await fsp.readFile(cpAbs);
  await writeFileAtomic(target, content.toString("utf8"));
  return `Восстановлено ${fileRel} из checkpoint ${rel}`;
}

export function listCheckpoints(
  projectRoot: string,
  limit = 40,
): Array<{ runId: string; relPath: string; checkpointPath: string; mtimeMs: number }> {
  const root = path.resolve(projectRoot);
  const cpRoot = checkpointsRoot(root);
  if (!fs.existsSync(cpRoot)) return [];
  const out: Array<{ runId: string; relPath: string; checkpointPath: string; mtimeMs: number }> =
    [];
  const runs = fs.readdirSync(cpRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
  for (const run of runs) {
    const runDir = path.join(cpRoot, run.name);
    const stack = [runDir];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (e.isFile()) {
          const st = fs.statSync(full);
          out.push({
            runId: run.name,
            relPath: path.relative(runDir, full).replace(/\\/g, "/"),
            checkpointPath: full,
            mtimeMs: st.mtimeMs,
          });
        }
      }
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, limit);
}

export function resolveProjectFile(raw: string, settings: AppSettings): string {
  const resolved = resolveAgentPath(raw, settings.projectRoot);
  return assertAllowedPath(
    resolved,
    settings.fileAccessMode,
    settings.projectRoot,
    settings.modelRoots,
  );
}

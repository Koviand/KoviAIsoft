import fs from "node:fs";
import path from "node:path";
import type { LocalModel } from "@kovi/shared";

function isPathInside(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const rel = path.relative(resolvedRoot, resolvedTarget);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** True when filePath is under at least one allowed model root. */
export function isUnderModelRoots(filePath: string, modelRoots: string[]): boolean {
  const roots = modelRoots.filter(Boolean).map((r) => path.resolve(r));
  return roots.some((root) => isPathInside(root, filePath));
}

function tryUnlink(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Не удалось удалить файл: ${filePath} (${msg})`);
  }
}

function otherGgufInDir(dir: string, exceptFile: string): boolean {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return false;
  }
  const except = path.resolve(exceptFile).toLowerCase();
  return entries.some((name) => {
    if (!name.toLowerCase().endsWith(".gguf")) return false;
    if (/mmproj/i.test(name)) return false;
    return path.resolve(dir, name).toLowerCase() !== except;
  });
}

function tryRemoveEmptyDir(dir: string): void {
  try {
    const left = fs.readdirSync(dir);
    if (left.length === 0) fs.rmdirSync(dir);
  } catch {
    // ignore — folder may still have sidecar files
  }
}

/**
 * Delete a local GGUF (and its mmproj if nothing else shares the folder).
 * Caller must unload the model from runtime first when it is loaded.
 */
export function deleteLocalModelFiles(
  model: LocalModel,
  modelRoots: string[],
): { deleted: string[] } {
  if (!isUnderModelRoots(model.path, modelRoots)) {
    throw new Error("Модель вне разрешённых папок — удаление запрещено");
  }
  if (!fs.existsSync(model.path)) {
    throw new Error("Файл модели уже отсутствует");
  }

  const deleted: string[] = [];
  tryUnlink(model.path);
  deleted.push(model.path);

  const mmproj = model.mmprojPath;
  if (
    mmproj &&
    isUnderModelRoots(mmproj, modelRoots) &&
    !otherGgufInDir(model.directory, model.path)
  ) {
    tryUnlink(mmproj);
    deleted.push(mmproj);
  }

  tryRemoveEmptyDir(model.directory);
  return { deleted };
}

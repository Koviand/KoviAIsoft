import fs from "node:fs";
import type { AppSettings } from "@kovi/shared";
import { assertAllowedPath, resolveAgentPath } from "./sandbox.js";
import { applyTextReplace } from "./textReplace.js";

function resolveDiffPath(filePath: string, settings?: AppSettings): string {
  if (!settings) return filePath;
  const resolved = resolveAgentPath(filePath, settings.projectRoot);
  assertAllowedPath(
    resolved,
    settings.fileAccessMode,
    settings.projectRoot,
    settings.modelRoots,
  );
  return resolved;
}

/** Tiny unified-diff style preview (no external deps). */
export function makeUnifiedDiff(
  filePath: string,
  before: string,
  after: string,
  maxLines = 200,
): string {
  const a = before.replace(/\r\n/g, "\n").split("\n");
  const b = after.replace(/\r\n/g, "\n").split("\n");
  const lines: string[] = [`--- a/${filePath}`, `+++ b/${filePath}`];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (lines.length >= maxLines) {
      lines.push("… (diff обрезан)");
      break;
    }
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push(` ${a[i]}`);
      i += 1;
      j += 1;
      continue;
    }
    // Prefer emitting removals then additions for the divergent span.
    const look = 4;
    let matched = false;
    for (let skipA = 0; skipA <= look && i + skipA < a.length; skipA++) {
      for (let skipB = 0; skipB <= look && j + skipB < b.length; skipB++) {
        if (a[i + skipA] === b[j + skipB]) {
          for (let k = 0; k < skipA; k++) lines.push(`-${a[i + k]}`);
          for (let k = 0; k < skipB; k++) lines.push(`+${b[j + k]}`);
          i += skipA;
          j += skipB;
          matched = true;
          break;
        }
      }
      if (matched) break;
    }
    if (matched) continue;
    if (i < a.length) {
      lines.push(`-${a[i]}`);
      i += 1;
    } else if (j < b.length) {
      lines.push(`+${b[j]}`);
      j += 1;
    }
  }
  return lines.join("\n");
}

export function previewWriteDiff(
  filePath: string,
  newContent: string,
  settings?: AppSettings,
): string {
  const resolved = resolveDiffPath(filePath, settings);
  let before = "";
  try {
    if (fs.existsSync(resolved)) before = fs.readFileSync(resolved, "utf8");
  } catch {
    before = "";
  }
  if (!before && newContent) {
    return `--- nul\n+++ b/${resolved}\n${newContent
      .split("\n")
      .slice(0, 120)
      .map((l) => `+${l}`)
      .join("\n")}`;
  }
  return makeUnifiedDiff(resolved, before, newContent);
}

export function previewPatchDiff(
  filePath: string,
  oldText: string,
  newText: string,
  settings?: AppSettings,
): string {
  const resolved = resolveDiffPath(filePath, settings);
  let current = "";
  try {
    current = fs.readFileSync(resolved, "utf8");
  } catch {
    return `Файл не найден: ${resolved}`;
  }
  if (!oldText) {
    return `oldText пустой для ${resolved}`;
  }
  try {
    const next = applyTextReplace(current, oldText, newText);
    return makeUnifiedDiff(resolved, current, next);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

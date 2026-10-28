import path from "node:path";
import type { FileAccessMode } from "@kovi/shared";

export function normalizePath(p: string): string {
  return path.resolve(p);
}

export function isPathInside(child: string, parent: string): boolean {
  const c = normalizePath(child).toLowerCase();
  const p = normalizePath(parent).toLowerCase();
  return c === p || c.startsWith(p + path.sep.toLowerCase());
}

export function assertAllowedPath(
  target: string,
  mode: FileAccessMode,
  projectRoot: string | null,
  roots: string[] = [],
): void {
  const resolved = normalizePath(target);
  if (mode === "project") {
    if (!projectRoot) {
      throw new Error("Режим project: сначала выберите папку проекта в настройках");
    }
    if (!isPathInside(resolved, projectRoot)) {
      throw new Error(`Путь вне папки проекта: ${resolved}`);
    }
    return;
  }
  // disk mode: allow listed roots + project; still block obvious system-critical writes via risk gates elsewhere
  const allowed = [...roots];
  if (projectRoot) allowed.push(projectRoot);
  if (allowed.length === 0) return;
  // In disk mode we allow any path; caller may still require confirmation for writes.
  void resolved;
}

export function isDangerousWrite(target: string): boolean {
  const p = normalizePath(target).toLowerCase();
  const blocked = [
    "\\windows\\",
    "\\program files\\",
    "\\program files (x86)\\",
  ];
  return blocked.some((b) => p.includes(b));
}

export function riskForTool(
  name: string,
  args: Record<string, unknown>,
): "low" | "medium" | "high" {
  if (["run_terminal", "browser_click", "browser_type"].includes(name)) return "high";
  if (["write_file", "apply_patch", "delete_path"].includes(name)) {
    const p = String(args.path || args.file || "");
    if (p && isDangerousWrite(p)) return "high";
    return "medium";
  }
  if (name.startsWith("mcp_") && /write|delete|create|update|exec/i.test(name)) return "medium";
  return "low";
}

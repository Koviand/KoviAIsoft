import path from "node:path";
import type { AgentRiskMode, FileAccessMode } from "@kovi/shared";

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

  // disk mode: only modelRoots + projectRoot
  const allowed = [...roots];
  if (projectRoot) allowed.push(projectRoot);
  if (allowed.length === 0) {
    throw new Error(
      "Режим disk: задайте папки моделей или папку проекта в настройках",
    );
  }
  if (!allowed.some((root) => isPathInside(resolved, root))) {
    throw new Error(`Путь вне разрешённых папок: ${resolved}`);
  }
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

/** Tools that must never be auto-remembered for the whole session. */
export const NEVER_REMEMBER_TOOLS = new Set([
  "run_terminal",
  "browser_click",
  "browser_type",
]);

/**
 * Stable approval key for "remember this action".
 * Returns null when the approval must not be remembered.
 */
export function approvalRememberKey(
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  if (NEVER_REMEMBER_TOOLS.has(toolName)) return null;
  if (["write_file", "apply_patch", "delete_path"].includes(toolName)) {
    const p = String(args.path || args.file || "").trim();
    if (!p) return null;
    return `${toolName}::${normalizePath(p).toLowerCase()}`;
  }
  return toolName;
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

/**
 * Whether the agent should prompt the user before running a tool.
 * - ask: confirm medium + high
 * - auto-safe: auto-approve medium when path is inside project; always confirm high
 * - full: skip confirms except dangerous system paths (forced high)
 */
export function shouldConfirmRisk(
  risk: "low" | "medium" | "high",
  mode: AgentRiskMode,
  args: Record<string, unknown>,
  projectRoot: string | null,
): boolean {
  if (risk === "low") return false;
  const target = String(args.path || args.file || args.cwd || "");
  if (target && isDangerousWrite(target)) return true;
  if (mode === "full") return risk === "high" && Boolean(target && isDangerousWrite(target));
  if (mode === "auto-safe") {
    if (risk === "high") return true;
    if (projectRoot && target && isPathInside(target, projectRoot)) {
      return false;
    }
    return true;
  }
  // ask
  return true;
}

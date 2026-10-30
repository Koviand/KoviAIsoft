import fs from "node:fs";
import path from "node:path";
import type { AgentRiskMode, FileAccessMode } from "@kovi/shared";

const WIN_RESERVED = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

export function normalizePath(p: string): string {
  return path.resolve(p);
}

/**
 * Collapse accidental over-escaped backslashes from model JSON
 * (C:\\Users\\foo → C:\Users\foo). Preserves UNC leading \\.
 */
export function collapseOverEscapedWinPath(input: string): string {
  const s = input.trim();
  if (!s) return s;
  // UNC: \\server\share — keep exactly two leading backslashes, collapse the rest
  if (/^\\\\[^\\/]/.test(s) || /^\/\/[^\\/]/.test(s)) {
    const rest = s.slice(2).replace(/\\{2,}/g, "\\");
    return s.slice(0, 2) + rest;
  }
  // Drive letter: C:\… or C:\\…
  if (/^[a-zA-Z]:/.test(s)) {
    return s.slice(0, 2) + s.slice(2).replace(/\\{2,}/g, "\\");
  }
  // Relative / other: collapse doubled backslashes only
  if (s.includes("\\\\")) {
    return s.replace(/\\{2,}/g, "\\");
  }
  return s;
}

/**
 * Resolve agent file/cwd paths for Windows:
 * - blank → projectRoot (when required)
 * - /C:/… or /c|… (MSYS/Git Bash) → real Windows absolute
 * - POSIX abs that mirrors projectRoot (e.g. /Users/…/AITEst/x) → under projectRoot
 * - other POSIX abs (/tmp/x) → relative to projectRoot
 * - relative → join(projectRoot)
 * - Windows absolute / UNC → as-is
 */
export function resolveAgentPath(
  raw: unknown,
  projectRoot: string | null,
  opts?: { allowBlankAsProject?: boolean },
): string {
  let input = raw == null ? "" : String(raw).trim();
  if (!input || input === "undefined" || input === "null") {
    if (opts?.allowBlankAsProject) {
      if (!projectRoot) {
        throw new Error("Нужна папка проекта в настройках");
      }
      return normalizePath(projectRoot);
    }
    throw new Error("Путь не задан");
  }

  input = collapseOverEscapedWinPath(input);

  // UNC keep as-is (//server/share or \\server\share)
  if (/^(\\\\|\/\/)[^\\/]+/.test(input)) {
    return normalizePath(input.replace(/\//g, path.sep));
  }

  if (process.platform === "win32") {
    // /C:/Users/... or /C|Users/... (Git Bash / MSYS / Cygwin)
    const msysColon = input.match(/^\/([a-zA-Z])[:|](\/.*)?$/);
    if (msysColon) {
      const drive = msysColon[1]!.toUpperCase();
      const rest = (msysColon[2] || "/").replace(/\//g, path.sep);
      return normalizePath(`${drive}:${rest}`);
    }
    // /c/Users/... (MSYS without colon) — not /tmp/...
    const msysSlash = input.match(
      /^\/([a-zA-Z])(\/(?:Users|Windows|Program Files|Documents and Settings)(?:\/|$).*)$/i,
    );
    if (msysSlash) {
      const drive = msysSlash[1]!.toUpperCase();
      const rest = msysSlash[2]!.replace(/\//g, path.sep);
      return normalizePath(`${drive}:${rest}`);
    }
    // "/C:\Users\..." rare form
    const slashWin = input.match(/^\/([a-zA-Z]:[\\/].+)$/);
    if (slashWin) {
      return normalizePath(slashWin[1]!.replace(/\//g, path.sep));
    }
  }

  // POSIX-looking absolute without drive → map onto project or treat as project-relative.
  if (process.platform === "win32" && /^\/(?!\/)/.test(input) && !/^[a-zA-Z]:/.test(input)) {
    if (!projectRoot) {
      throw new Error(`Unix-путь «${input}» требует папку проекта`);
    }
    const rootNorm = normalizePath(projectRoot);
    const rootNoDrive = rootNorm.replace(/^[a-zA-Z]:/, "").replace(/^[\\/]+/, "");
    const posixNoLead = input.replace(/^\/+/, "").replace(/\//g, path.sep);
    if (
      rootNoDrive &&
      posixNoLead.toLowerCase().startsWith(rootNoDrive.toLowerCase())
    ) {
      const rem = posixNoLead.slice(rootNoDrive.length).replace(/^[\\/]+/, "");
      return normalizePath(rem ? path.join(rootNorm, rem) : rootNorm);
    }
    return normalizePath(path.join(projectRoot, posixNoLead));
  }

  input = input.replace(/\//g, path.sep);

  // Reject NTFS ADS-looking paths: file.txt:stream (drive letter colon is ok).
  if (/^[a-zA-Z]:/.test(input)) {
    if (input.slice(2).includes(":")) {
      throw new Error(`Подозрительный путь (ADS/stream): ${input}`);
    }
  } else if (input.includes(":")) {
    throw new Error(`Подозрительный путь (ADS/stream): ${input}`);
  }

  if (!path.isAbsolute(input)) {
    if (!projectRoot) {
      throw new Error(`Относительный путь «${input}» требует папку проекта`);
    }
    return normalizePath(path.join(projectRoot, input));
  }
  return normalizePath(input);
}

export function isPathInside(child: string, parent: string): boolean {
  const c = normalizePath(child).toLowerCase();
  const p = normalizePath(parent).toLowerCase();
  return c === p || c.startsWith(p + path.sep.toLowerCase());
}

export function assertNotReservedWinName(target: string): void {
  const base = path.basename(target).toLowerCase();
  const stem = base.includes(".") ? base.slice(0, base.indexOf(".")) : base;
  if (WIN_RESERVED.has(stem) || WIN_RESERVED.has(base)) {
    throw new Error(`Запрещённое имя Windows: ${path.basename(target)}`);
  }
}

/** Resolve reparse points when possible; fall back to logical path. */
export function realPathSafe(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return normalizePath(target);
  }
}

/**
 * Walk up until an existing path and realpath it.
 * Used so new files behind junctions cannot escape the sandbox.
 */
export function realPathExistingAncestor(target: string): string {
  let cur = normalizePath(target);
  const seen = new Set<string>();
  for (;;) {
    const key = cur.toLowerCase();
    if (seen.has(key)) break;
    seen.add(key);
    try {
      return fs.realpathSync(cur);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  return normalizePath(target);
}

function projectedRealPath(target: string): string {
  const resolved = normalizePath(target);
  try {
    return fs.realpathSync(resolved);
  } catch {
    // Preserve missing relative segments: proj\a\b\c.txt → real(proj)\a\b\c.txt
    const segments: string[] = [];
    let cur = resolved;
    const seen = new Set<string>();
    for (;;) {
      const key = cur.toLowerCase();
      if (seen.has(key)) break;
      seen.add(key);
      try {
        const real = fs.realpathSync(cur);
        return normalizePath(segments.length ? path.join(real, ...segments) : real);
      } catch {
        const base = path.basename(cur);
        const parent = path.dirname(cur);
        if (parent === cur) break;
        segments.unshift(base);
        cur = parent;
      }
    }
    return resolved;
  }
}

export function assertAllowedPath(
  target: string,
  mode: FileAccessMode,
  projectRoot: string | null,
  roots: string[] = [],
): string {
  const resolved = normalizePath(target);
  assertNotReservedWinName(resolved);
  if (isDangerousSystemDir(resolved)) {
    throw new Error(`Запрещённый системный путь: ${resolved}`);
  }

  const real = projectedRealPath(resolved);
  if (mode === "project") {
    if (!projectRoot) {
      throw new Error("Режим project: сначала выберите папку проекта в настройках");
    }
    const rootReal = realPathSafe(projectRoot);
    if (
      !isPathInside(resolved, projectRoot) &&
      !isPathInside(real, rootReal) &&
      !isPathInside(real, projectRoot)
    ) {
      throw new Error(`Путь вне папки проекта: ${resolved}`);
    }
    // Junction escape: logical path inside project, real path outside.
    if (
      isPathInside(resolved, projectRoot) &&
      !isPathInside(real, rootReal) &&
      !isPathInside(real, projectRoot)
    ) {
      throw new Error(`Путь вне папки проекта (через ссылку): ${resolved}`);
    }
    return resolved;
  }

  const allowed = [...roots];
  if (projectRoot) allowed.push(projectRoot);
  if (allowed.length === 0) {
    throw new Error(
      "Режим disk: задайте папки моделей или папку проекта в настройках",
    );
  }
  const ok = allowed.some((root) => {
    const rootReal = realPathSafe(root);
    return (
      isPathInside(resolved, root) ||
      isPathInside(real, rootReal) ||
      isPathInside(real, root)
    );
  });
  if (!ok) {
    throw new Error(`Путь вне разрешённых папок: ${resolved}`);
  }
  return resolved;
}

export function isDangerousSystemDir(target: string): boolean {
  let p = normalizePath(target).toLowerCase().replace(/\\+$/, "");
  // Strip \\?\ / \\.\ prefixes
  p = p.replace(/^\\\\\?\\/, "").replace(/^\\\\\.\\/, "");
  if (/^[a-z]:$/.test(p)) return true;
  // Any drive's Windows / Program Files / sensitive roots
  if (/^[a-z]:\\windows(\\|$)/.test(p)) return true;
  if (/^[a-z]:\\program files( \(x86\))?(\\|$)/.test(p)) return true;
  if (/^[a-z]:\\programdata(\\|$)/.test(p)) return true;
  if (/^[a-z]:\\\$recycle\.bin(\\|$)/.test(p)) return true;
  if (/^[a-z]:\\system volume information(\\|$)/.test(p)) return true;
  // User secrets
  if (/\\users\\[^\\]+\\\.ssh(\\|$)/.test(p)) return true;
  if (/\\users\\[^\\]+\\\.gnupg(\\|$)/.test(p)) return true;
  if (/\\users\\[^\\]+\\appdata\\roaming\\gnupg(\\|$)/.test(p)) return true;
  return false;
}

/** @deprecated use isDangerousSystemDir */
export function isDangerousWrite(target: string): boolean {
  return isDangerousSystemDir(target);
}

/**
 * Working directory policy for run_terminal (Windows agent).
 * - project mode: must stay inside projectRoot
 * - disk mode: must stay inside projectRoot ∪ modelRoots (same as file tools)
 */
/**
 * Block absolute `cd` / Set-Location outside allowed roots and common download+exec patterns.
 * Relative paths are allowed (cwd is already sandboxed).
 */
export function assertShellCommandPolicy(
  command: string,
  allowedRoots: string[],
): void {
  const cmd = String(command || "");
  if (!cmd.trim()) return;

  if (
    /Invoke-WebRequest[\s\S]{0,240}\|\s*i(ex|nvoke-expression)/i.test(cmd) ||
    /\biwr\b[\s\S]{0,120}\|\s*iex\b/i.test(cmd) ||
    /curl(\.exe)?[\s\S]{0,120}\|\s*(ba)?sh\b/i.test(cmd) ||
    /wget(\.exe)?[\s\S]{0,120}\|\s*(ba)?sh\b/i.test(cmd)
  ) {
    throw new Error(
      "Команда download→exec запрещена (pipe в iex/sh). Скачайте файл отдельно и проверьте его.",
    );
  }

  const roots = allowedRoots.filter(Boolean).map((r) => normalizePath(r));
  if (roots.length === 0) return;

  const cdRe =
    /(?:^|[\n;&|]\s*)(?:cd(?:\s+\/[dD])?|chdir|Set-Location|\bsl)\s+(?:"([^"]+)"|'([^']+)'|([^\n;&|]+))/gi;
  let m: RegExpExecArray | null;
  while ((m = cdRe.exec(cmd)) !== null) {
    const raw = (m[1] || m[2] || m[3] || "").trim();
    if (!raw || raw === "." || raw === ".." || /^[~%]/.test(raw)) continue;
    // Skip /d flag leftovers and switches
    if (/^\/[a-z]$/i.test(raw)) continue;
    const candidate = collapseOverEscapedWinPath(raw.replace(/^\/d\s+/i, "").trim());
    const isAbs =
      /^[a-zA-Z]:[\\/]/.test(candidate) ||
      candidate.startsWith("\\\\") ||
      candidate.startsWith("//") ||
      /^\/[a-zA-Z]\//.test(candidate);
    if (!isAbs) continue;
    let resolved: string;
    try {
      resolved = normalizePath(candidate.replace(/^\/([a-zA-Z])\//, "$1:/"));
    } catch {
      continue;
    }
    const ok = roots.some(
      (root) => isPathInside(resolved, root) || isPathInside(realPathSafe(resolved), realPathSafe(root)),
    );
    if (!ok) {
      throw new Error(
        `Смена каталога вне разрешённых папок запрещена: ${resolved}`,
      );
    }
  }
}

export function assertTerminalCwd(
  cwd: string,
  mode: FileAccessMode,
  projectRoot: string | null,
  roots: string[] = [],
): void {
  const resolved = normalizePath(cwd);
  if (isDangerousSystemDir(resolved)) {
    throw new Error(`Запрещённый системный каталог для shell: ${resolved}`);
  }
  if (mode === "project") {
    if (!projectRoot) {
      throw new Error("Режим project: сначала выберите папку проекта в настройках");
    }
    const rootReal = realPathSafe(projectRoot);
    const cwdReal = realPathSafe(resolved);
    if (!isPathInside(resolved, projectRoot) && !isPathInside(cwdReal, rootReal)) {
      throw new Error(`cwd вне папки проекта: ${resolved}`);
    }
    return;
  }
  // disk: same roots policy as assertAllowedPath
  const allowed = [...roots];
  if (projectRoot) allowed.push(projectRoot);
  if (allowed.length === 0) {
    throw new Error(
      "Режим disk: задайте папки моделей или папку проекта для shell cwd",
    );
  }
  const cwdReal = realPathSafe(resolved);
  const ok = allowed.some((root) => {
    const rootReal = realPathSafe(root);
    return isPathInside(resolved, root) || isPathInside(cwdReal, rootReal);
  });
  if (!ok) {
    throw new Error(`cwd вне разрешённых папок: ${resolved}`);
  }
}

export const NEVER_REMEMBER_TOOLS = new Set([
  "run_terminal",
  "browser_click",
  "browser_type",
  "browser_navigate",
]);

export function approvalRememberKey(
  toolName: string,
  args: Record<string, unknown>,
  projectRoot: string | null = null,
): string | null {
  if (NEVER_REMEMBER_TOOLS.has(toolName)) return null;
  if (["write_file", "apply_patch", "delete_path"].includes(toolName)) {
    const p = String(args.path || args.file || "").trim();
    if (!p) return null;
    try {
      return `${toolName}::${resolveAgentPath(p, projectRoot).toLowerCase()}`;
    } catch {
      return `${toolName}::${normalizePath(p).toLowerCase()}`;
    }
  }
  return toolName;
}

export function riskForTool(
  name: string,
  args: Record<string, unknown>,
  projectRoot: string | null = null,
): "low" | "medium" | "high" {
  if (["run_terminal", "browser_click", "browser_type", "browser_navigate"].includes(name)) {
    return "high";
  }
  if (name === "browser_snapshot") return "medium";
  if (name.startsWith("mcp_")) return "medium";
  if (name === "delete_path") {
    const p = String(args.path || args.file || "");
    if (p && isDangerousSystemDir(p)) return "high";
    // Deleting project root or any directory is always high.
    try {
      const resolved = resolveAgentPath(p, projectRoot);
      if (projectRoot && isPathInside(projectRoot, resolved) && isPathInside(resolved, projectRoot)) {
        return "high";
      }
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) return "high";
    } catch {
      return "high";
    }
    return "medium";
  }
  if (["write_file", "apply_patch"].includes(name)) {
    const p = String(args.path || args.file || "");
    if (p && isDangerousSystemDir(p)) return "high";
    return "medium";
  }
  if (name.startsWith("mcp_") && /write|delete|create|update|exec/i.test(name)) return "medium";
  return "low";
}

/**
 * - ask: confirm medium + high
 * - auto-safe: auto-approve medium files inside project; always confirm high (incl. shell)
 * - full: skip medium; ALWAYS confirm high (shell / dangerous deletes)
 */
export function shouldConfirmRisk(
  risk: "low" | "medium" | "high",
  mode: AgentRiskMode,
  args: Record<string, unknown>,
  projectRoot: string | null,
  toolName?: string,
): boolean {
  if (risk === "low") return false;
  const target = String(args.path || args.file || args.cwd || "");
  if (target && isDangerousSystemDir(target)) return true;

  // Never auto-approve shell / browser mutations, even in "full".
  if (
    toolName &&
    ["run_terminal", "browser_click", "browser_type"].includes(toolName)
  ) {
    return true;
  }
  if (risk === "high") return true;

  if (mode === "full") return false;

  if (mode === "auto-safe") {
    if (toolName === "delete_path") return true;
    if (projectRoot && target) {
      try {
        const resolved = resolveAgentPath(target, projectRoot);
        if (isPathInside(resolved, projectRoot)) return false;
      } catch {
        return true;
      }
    }
    return true;
  }
  // ask
  return true;
}

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import type { AppSettings } from "@kovi/shared";
import {
  assertTerminalCwd,
  normalizePath,
  resolveAgentPath,
} from "./sandbox.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 4 * 1024 * 1024;

/** True when cwd arg is missing / placeholder from the model. */
export function isBlankCwd(cwd: unknown): boolean {
  if (cwd == null) return true;
  const s = String(cwd).trim();
  return !s || s === "undefined" || s === "null" || s === "." || s === "./";
}

/**
 * Resolve working directory for Windows agent shell.
 */
export function resolveTerminalCwd(
  cwd: unknown,
  projectRoot: string | null,
): string {
  return resolveAgentPath(cwd, projectRoot, { allowBlankAsProject: true });
}

/**
 * Soft-adapt common Unix one-liners to cmd.exe so agent loops don't fail on Windows.
 */
/** Detect bash/heredoc or shell redirects meant to write source files. */
export function isShellFileWriteAttempt(command: string): boolean {
  const c = command.trim();
  if (!c) return false;
  if (/<<\s*['-]?\w+/.test(c)) return true;
  if (/\btee\b/i.test(c) && />/.test(c)) return true;
  if (/\bcat\b/i.test(c) && />\s*[^|&\s]/.test(c)) return true;
  if (
    /(^|[;&|])\s*echo\b[\s\S]*>\s*[^|&]+\.(py|ts|tsx|js|jsx|html|css|json|md|rs|go|java|cs)\b/i.test(
      c,
    )
  ) {
    return true;
  }
  return false;
}

export function adaptCommandForWindows(command: string, cwd?: string): string {
  const trimmed = command.trim();
  if (!trimmed) return trimmed;

  if (isShellFileWriteAttempt(trimmed)) {
    throw new Error(
      "Запись кода через shell (heredoc/echo >/cat >) на Windows ненадёжна — используй инструмент write_file",
    );
  }

  if (/^(pwsh|powershell)(\.exe)?(\s|$)/i.test(trimmed)) return trimmed;
  if (/^(cmd)(\.exe)?\s/i.test(trimmed)) return trimmed;

  if (/^pwd\s*$/i.test(trimmed)) return "cd";
  if (/^clear\s*$/i.test(trimmed) || /^cls\s*$/i.test(trimmed)) return "cls";
  if (/^ls(\s+-+\S+)*\s*$/i.test(trimmed)) return "dir /b";
  if (/^ls\s+/i.test(trimmed) && !/[|&><]/.test(trimmed)) {
    const rest = trimmed
      .replace(/^ls\s+/i, "")
      .replace(/^(-[a-zA-Z0-9]+|--\S+)\s*/i, "")
      .trim();
    return rest ? `dir /b ${quoteIfNeeded(rest)}` : "dir /b";
  }
  if (/^cat\s+(.+)$/i.test(trimmed) && !/[|&><]/.test(trimmed)) {
    const file = trimmed.replace(/^cat\s+/i, "").trim();
    return `type ${quoteIfNeeded(file)}`;
  }
  if (/^rm\s+-rf?\s+(.+)$/i.test(trimmed) && !/[|&><]/.test(trimmed)) {
    const target = trimmed.replace(/^rm\s+-rf?\s+/i, "").trim().replace(/^["']|["']$/g, "");
    if (target === "." || target === ".." || target === "*" || target === "*.*") {
      throw new Error("Опасная команда rm по текущей папке/маске запрещена");
    }
    const abs = cwd ? path.resolve(cwd, target) : target;
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        return `del /q ${quoteIfNeeded(target)}`;
      }
    } catch {
      // fall through to rmdir
    }
    return `rmdir /s /q ${quoteIfNeeded(target)}`;
  }
  if (/^rm\s+(.+)$/i.test(trimmed) && !/[|&><]/.test(trimmed)) {
    const target = trimmed.replace(/^rm\s+/i, "").trim();
    return `del /q ${quoteIfNeeded(target)}`;
  }
  if (/^cp\s+(\S+)\s+(\S+)$/i.test(trimmed) && !/[|&><]/.test(trimmed)) {
    const m = trimmed.match(/^cp\s+(\S+)\s+(\S+)$/i)!;
    return `copy /y ${quoteIfNeeded(m[1])} ${quoteIfNeeded(m[2])}`;
  }
  if (/^mv\s+(\S+)\s+(\S+)$/i.test(trimmed) && !/[|&><]/.test(trimmed)) {
    const m = trimmed.match(/^mv\s+(\S+)\s+(\S+)$/i)!;
    return `move /y ${quoteIfNeeded(m[1])} ${quoteIfNeeded(m[2])}`;
  }
  if (/^touch\s+(.+)$/i.test(trimmed) && !/[|&><]/.test(trimmed)) {
    const file = trimmed.replace(/^touch\s+/i, "").trim();
    const q = quoteIfNeeded(file);
    return `if not exist ${q} (type nul > ${q})`;
  }
  if (/^which\s+(\S+)$/i.test(trimmed)) {
    const bin = trimmed.replace(/^which\s+/i, "").trim();
    return `where ${quoteIfNeeded(bin)}`;
  }
  if (/^mkdir\s+-p\s+(.+)$/i.test(trimmed) && !/[|&><]/.test(trimmed)) {
    const dir = trimmed.replace(/^mkdir\s+-p\s+/i, "").trim();
    return `mkdir ${quoteIfNeeded(dir)}`;
  }

  return trimmed;
}

function quoteIfNeeded(value: string): string {
  const v = value.trim().replace(/^["']|["']$/g, "");
  if (!/\s/.test(v)) return v;
  return `"${v.replace(/"/g, '""')}"`;
}

function formatResult(
  command: string,
  cwd: string,
  exitCode: number,
  stdout: string,
  stderr: string,
): string {
  const parts = [
    `$ ${command}`,
    `cwd: ${cwd}`,
    `exit: ${exitCode}`,
    stdout?.trimEnd() ? stdout.trimEnd() : "",
    stderr?.trimEnd() ? `stderr:\n${stderr.trimEnd()}` : "",
  ].filter(Boolean);
  return parts.join("\n");
}

type ShellResult = { stdout: string; stderr: string; code: number };

function execCapture(
  file: string,
  args: string[],
  cwd: string,
): Promise<ShellResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        cwd,
        windowsHide: true,
        timeout: DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        encoding: "utf8",
        env: {
          ...process.env,
          PYTHONUTF8: "1",
          PYTHONIOENCODING: "utf-8",
        },
      },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ stdout: String(stdout || ""), stderr: String(stderr || ""), code: 0 });
          return;
        }
        const e = err as NodeJS.ErrnoException & {
          code?: string | number;
          killed?: boolean;
          stdout?: string;
          stderr?: string;
        };
        if (typeof e.code === "number") {
          resolve({
            stdout: String(e.stdout ?? stdout ?? ""),
            stderr: String(e.stderr ?? stderr ?? ""),
            code: e.code,
          });
          return;
        }
        if (e.killed) {
          reject(new Error(`Команда превысила лимит ${DEFAULT_TIMEOUT_MS / 1000}с`));
          return;
        }
        reject(err);
      },
    );
  });
}

function powershellExe(): string {
  if (process.env.SystemRoot) {
    return path.join(
      process.env.SystemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
  }
  return "powershell.exe";
}

async function runViaPowerShell(command: string, cwd: string): Promise<ShellResult> {
  const body = command.replace(/^(pwsh|powershell)(\.exe)?\s+/i, "").trim();
  const ps = [
    "$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::UTF8;",
    body,
  ].join(" ");
  return execCapture(powershellExe(), [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    ps,
  ], cwd);
}

async function runViaCmd(command: string, cwd: string): Promise<ShellResult> {
  const comspec = process.env.ComSpec || "cmd.exe";
  const wrapped = `chcp 65001>nul & ${command}`;
  return execCapture(comspec, ["/d", "/s", "/c", wrapped], cwd);
}

/**
 * Run a shell command on Windows for the agent tool-loop.
 * Non-zero exit codes are returned as text (not thrown).
 */
export async function runTerminal(
  command: string,
  cwd: string,
  settings: AppSettings,
): Promise<string> {
  const rawCmd = String(command ?? "").trim();
  if (!rawCmd) throw new Error("Пустая команда run_terminal");

  const resolvedCwd = resolveTerminalCwd(cwd, settings.projectRoot);
  assertTerminalCwd(
    resolvedCwd,
    settings.fileAccessMode,
    settings.projectRoot,
    settings.modelRoots || [],
  );

  let st: fs.Stats;
  try {
    st = fs.statSync(resolvedCwd);
  } catch {
    throw new Error(`cwd не существует: ${resolvedCwd}`);
  }
  if (!st.isDirectory()) {
    throw new Error(`cwd не является папкой: ${resolvedCwd}`);
  }

  let adapted: string;
  try {
    adapted = adaptCommandForWindows(rawCmd, resolvedCwd);
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }
  const usePs = /^(pwsh|powershell)(\.exe)?(\s|$)/i.test(adapted);

  try {
    const result = usePs
      ? await runViaPowerShell(adapted, resolvedCwd)
      : await runViaCmd(adapted, resolvedCwd);
    return formatResult(adapted, resolvedCwd, result.code, result.stdout, result.stderr);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Ошибка shell (${resolvedCwd}): ${message}`);
  }
}

// re-export for tests that imported normalizePath via terminal historically
export { normalizePath };

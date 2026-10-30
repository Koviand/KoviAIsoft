import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AppSettings } from "@kovi/shared";
import {
  assertShellCommandPolicy,
  assertTerminalCwd,
  collapseOverEscapedWinPath,
  normalizePath,
  resolveAgentPath,
} from "./sandbox.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 4 * 1024 * 1024;

function killProcessTree(pid: number): void {
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
        detached: true,
      }).unref();
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // ignore
    }
  }
}

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
  if (isBlankCwd(cwd)) {
    return resolveAgentPath("", projectRoot, { allowBlankAsProject: true });
  }
  return resolveAgentPath(cwd, projectRoot, { allowBlankAsProject: true });
}

/**
 * Fix over-escaped Windows drive paths inside a shell command string
 * (e.g. `dir C:\\Users\\foo` → `dir C:\Users\foo`). Leaves UNC alone.
 */
export function collapseOverEscapedWinPathsInCommand(command: string): string {
  if (!command || !command.includes("\\")) return command;
  // Quoted paths first (may contain spaces)
  let out = command.replace(
    /(["'])([A-Za-z]:(?:\\+|\/)(?:(?!\1).)*)\1/g,
    (_full, q: string, inner: string) => {
      if (!/\\\\/.test(inner) && !/\/\//.test(inner)) return `${q}${inner}${q}`;
      const collapsed = collapseOverEscapedWinPath(inner.replace(/\//g, "\\"));
      return `${q}${collapsed}${q}`;
    },
  );
  // Unquoted drive paths up to whitespace / shell metachar
  out = out.replace(
    /([A-Za-z]:)((?:\\+|\/)[^"'\s|&<>]*)/g,
    (full, drive: string, rest: string) => {
      if (!/\\\\/.test(rest) && !/\/\//.test(rest)) return full;
      return collapseOverEscapedWinPath(drive + rest.replace(/\//g, "\\"));
    },
  );
  return out;
}

/**
 * Soft-adapt common Unix one-liners to cmd.exe so agent loops don't fail on Windows.
 */
/** Detect bash/heredoc or shell redirects meant to write source files. */
export function isShellFileWriteAttempt(command: string): boolean {
  const c = command.trim();
  if (!c) return false;
  // Heredoc used to write a file (cat/tee/echo > file <<EOF), not git commit -m "$(cat <<EOF"
  if (
    /\b(cat|tee)\b[\s\S]*>\s*[^|&\s]+[\s\S]*<<\s*['-]?\w+/i.test(c) ||
    /\b(cat|tee)\b[\s\S]*<<\s*['-]?\w+[\s\S]*>\s*[^|&\s]+/i.test(c)
  ) {
    return true;
  }
  if (/\btee\b/i.test(c) && />/.test(c) && !/\bgit\b/i.test(c)) return true;
  if (/\bcat\b/i.test(c) && />\s*[^|&\s]/.test(c) && !/\bgit\b/i.test(c)) return true;
  if (
    /(^|[;&|])\s*echo\b[\s\S]*>\s*[^|&]+\.(py|ts|tsx|js|jsx|html|css|json|md|rs|go|java|cs)\b/i.test(
      c,
    )
  ) {
    return true;
  }
  // Bare heredoc writing to a code file without git context
  if (
    /<<\s*['-]?\w+/.test(c) &&
    />\s*[^|&]+\.(py|ts|tsx|js|jsx|html|css|json|md|rs|go|java|cs)\b/i.test(c)
  ) {
    return true;
  }
  return false;
}

function quoteIfNeeded(value: string): string {
  const v = value.trim().replace(/^["']|["']$/g, "");
  if (!/\s/.test(v)) return v;
  // Trailing backslash before " breaks cmd quoting — double it.
  const safe = v.replace(/\\+$/g, (m) => m + m).replace(/"/g, '""');
  return `"${safe}"`;
}

/** Split on && || ; outside quotes (keeps separators). */
export function splitShellChain(command: string): string[] {
  const parts: string[] = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      buf += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      buf += ch;
      continue;
    }
    if (!inSingle && !inDouble) {
      if (command.slice(i, i + 2) === "&&" || command.slice(i, i + 2) === "||") {
        parts.push(buf.trim());
        parts.push(command.slice(i, i + 2));
        buf = "";
        i += 1;
        continue;
      }
      if (ch === ";" ) {
        parts.push(buf.trim());
        parts.push(";");
        buf = "";
        continue;
      }
    }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts.filter((p) => p.length > 0);
}

function adaptSingleSegment(trimmed: string, cwd?: string): string {
  if (!trimmed) return trimmed;

  if (/^(pwsh|powershell)(\.exe)?(\s|$)/i.test(trimmed)) return trimmed;
  if (/^(cmd)(\.exe)?\s/i.test(trimmed)) return trimmed;

  // export FOO=bar → set "FOO=bar"
  const exportM = trimmed.match(/^export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/i);
  if (exportM) {
    const val = exportM[2]!.trim().replace(/^["']|["']$/g, "");
    return `set "${exportM[1]}=${val}"`;
  }

  // FOO=bar cmd… → set "FOO=bar" && cmd…
  const envPrefix = trimmed.match(
    /^([A-Za-z_][A-Za-z0-9_]*)=([^\s]+)\s+(.+)$/,
  );
  if (envPrefix && !/^(set|call)\b/i.test(envPrefix[3]!)) {
    const val = envPrefix[2]!.replace(/^["']|["']$/g, "");
    return `set "${envPrefix[1]}=${val}" && ${adaptSingleSegment(envPrefix[3]!, cwd)}`;
  }

  // bash redirects
  let seg = trimmed
    .replace(/\s+2\s*>\s*\/dev\/null\b/gi, " 2>nul")
    .replace(/\s+>\s*\/dev\/null\b/gi, " >nul")
    .replace(/\s+2\s*>&\s*1\b/g, " 2>&1");

  // python/node -c with single quotes → double quotes for cmd
  seg = seg.replace(
    /\b(python|py|python3|node)\s+(-c|-e)\s+'([^']*)'/gi,
    (_m, bin: string, flag: string, code: string) => {
      const escaped = code.replace(/"/g, '\\"');
      return `${bin} ${flag} "${escaped}"`;
    },
  );

  // cd D:\path → cd /d D:\path (cross-drive)
  if (/^cd\s+[A-Za-z]:/i.test(seg) && !/^cd\s+\/d\s+/i.test(seg)) {
    seg = seg.replace(/^cd\s+/i, "cd /d ");
  }

  if (/^pwd\s*$/i.test(seg)) return "cd";
  if (/^clear\s*$/i.test(seg) || /^cls\s*$/i.test(seg)) return "cls";
  if (/^ls(\s+-+\S+)*\s*$/i.test(seg)) return "dir /b";
  if (/^ls\s+/i.test(seg) && !/[|&><]/.test(seg)) {
    const rest = seg
      .replace(/^ls\s+/i, "")
      .replace(/^(-[a-zA-Z0-9]+|--\S+)\s*/i, "")
      .trim();
    return rest ? `dir /b ${quoteIfNeeded(rest)}` : "dir /b";
  }
  if (/^cat\s+(.+)$/i.test(seg) && !/[|&><]/.test(seg)) {
    const file = seg.replace(/^cat\s+/i, "").trim();
    return `type ${quoteIfNeeded(file)}`;
  }
  if (/^rm\s+-rf?\s+(.+)$/i.test(seg) && !/[|&><]/.test(seg)) {
    const target = seg.replace(/^rm\s+-rf?\s+/i, "").trim().replace(/^["']|["']$/g, "");
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
  if (/^rm\s+(.+)$/i.test(seg) && !/[|&><]/.test(seg)) {
    const target = seg.replace(/^rm\s+/i, "").trim();
    return `del /q ${quoteIfNeeded(target)}`;
  }
  if (/^cp\s+-r\s+(\S+)\s+(\S+)$/i.test(seg) && !/[|&><]/.test(seg)) {
    const m = seg.match(/^cp\s+-r\s+(\S+)\s+(\S+)$/i)!;
    return `xcopy /e /i /y ${quoteIfNeeded(m[1]!)} ${quoteIfNeeded(m[2]!)}`;
  }
  if (/^cp\s+(\S+)\s+(\S+)$/i.test(seg) && !/[|&><]/.test(seg)) {
    const m = seg.match(/^cp\s+(\S+)\s+(\S+)$/i)!;
    return `copy /y ${quoteIfNeeded(m[1]!)} ${quoteIfNeeded(m[2]!)}`;
  }
  if (/^mv\s+(\S+)\s+(\S+)$/i.test(seg) && !/[|&><]/.test(seg)) {
    const m = seg.match(/^mv\s+(\S+)\s+(\S+)$/i)!;
    return `move /y ${quoteIfNeeded(m[1]!)} ${quoteIfNeeded(m[2]!)}`;
  }
  if (/^touch\s+(.+)$/i.test(seg) && !/[|&><]/.test(seg)) {
    const file = seg.replace(/^touch\s+/i, "").trim();
    const q = quoteIfNeeded(file);
    return `if not exist ${q} (type nul > ${q})`;
  }
  if (/^which\s+(\S+)$/i.test(seg)) {
    const bin = seg.replace(/^which\s+/i, "").trim();
    return `where ${quoteIfNeeded(bin)}`;
  }
  if (/^mkdir\s+-p\s+(.+)$/i.test(seg) && !/[|&><]/.test(seg)) {
    const dir = seg.replace(/^mkdir\s+-p\s+/i, "").trim();
    return `mkdir ${quoteIfNeeded(dir)}`;
  }
  if (/^grep\s+/i.test(seg) && !/[|&><]/.test(seg)) {
    const rest = seg.replace(/^grep\s+/i, "").replace(/^-n\s+/i, "").trim();
    const m = rest.match(/^(\S+)\s+(.+)$/);
    if (m) {
      return `findstr /n /i /c:${quoteIfNeeded(m[1]!)} ${quoteIfNeeded(m[2]!)}`;
    }
  }

  // Prefix package-manager .cmd shims so && chains continue
  if (
    /^(npm|npx|yarn|pnpm|pip|pip3)(\.cmd)?(\s|$)/i.test(seg) &&
    !/^call\s+/i.test(seg)
  ) {
    return `call ${seg}`;
  }

  return seg;
}

export function adaptCommandForWindows(command: string, cwd?: string): string {
  const trimmed = command.trim();
  if (!trimmed) return trimmed;

  if (isShellFileWriteAttempt(trimmed)) {
    throw new Error(
      "Запись кода через shell (heredoc/echo >/cat >) на Windows ненадёжна — используй инструмент write_file",
    );
  }

  // Reject remaining bash heredoc (e.g. git commit <<EOF) with a clearer hint
  if (/<<\s*['-]?\w+/.test(trimmed)) {
    throw new Error(
      "Heredoc (<<EOF) в cmd не поддерживается. Для git commit используй: git commit -m \"сообщение\". Для кода — write_file.",
    );
  }

  if (/\$\(|`/.test(trimmed) && !/^(pwsh|powershell)/i.test(trimmed)) {
    throw new Error(
      "Подстановки $(…) / backticks — синтаксис bash. На Windows: простые cmd-команды или префикс powershell …",
    );
  }

  // Whole-command powershell/cmd passthrough (may itself contain &&)
  if (/^(pwsh|powershell)(\.exe)?(\s|$)/i.test(trimmed)) return trimmed;
  if (/^(cmd)(\.exe)?\s/i.test(trimmed)) return trimmed;

  const parts = splitShellChain(trimmed);
  if (parts.length === 1) {
    return adaptSingleSegment(parts[0]!, cwd);
  }

  return parts
    .map((p) => {
      if (p === "&&" || p === "||" || p === ";") return p === ";" ? "&" : p;
      return adaptSingleSegment(p, cwd);
    })
    .join(" ");
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
    const child = spawn(file, args, {
      cwd,
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killProcessTree(child.pid);
      child.kill();
      finish(() =>
        reject(new Error(`Команда превысила лимит ${DEFAULT_TIMEOUT_MS / 1000}с`)),
      );
    }, DEFAULT_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
      if (stdout.length > MAX_BUFFER) stdout = stdout.slice(-MAX_BUFFER);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
      if (stderr.length > MAX_BUFFER) stderr = stderr.slice(-MAX_BUFFER);
    });
    child.on("error", (err) => {
      finish(() => reject(err));
    });
    child.on("close", (code) => {
      if (timedOut) return;
      finish(() =>
        resolve({
          stdout,
          stderr,
          code: typeof code === "number" ? code : 1,
        }),
      );
    });
  });
}

function powershellExe(preferPwsh: boolean): string {
  if (preferPwsh) {
    // Prefer pwsh from PATH when model asked for it; fall back to Windows PowerShell.
    return "pwsh.exe";
  }
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
  const preferPwsh = /^pwsh(\.exe)?(\s|$)/i.test(command);
  let body = command.replace(/^(pwsh|powershell)(\.exe)?\s+/i, "").trim();
  const exe = powershellExe(preferPwsh);

  // Drop flags we always inject so we don't pass them twice.
  body = body
    .replace(/^(-NoProfile\s+|-NonInteractive\s+|-ExecutionPolicy\s+\S+\s+)+/i, "")
    .trim();

  // Model already used -File / -EncodedCommand — pass through without wrapping -Command.
  const fileM = body.match(/^-File\s+(.+)$/i);
  if (fileM) {
    return execCapture(
      exe,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fileM[1]!.trim().replace(/^["']|["']$/g, "")],
      cwd,
    );
  }
  const encM = body.match(/^-EncodedCommand\s+(\S+)$/i);
  if (encM) {
    return execCapture(
      exe,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encM[1]!],
      cwd,
    );
  }

  // powershell -Command "..." → unwrap once (avoid -Command -Command)
  if (/^-Command\s+/i.test(body)) {
    body = body.replace(/^-Command\s+/i, "").trim();
    if (
      (body.startsWith('"') && body.endsWith('"')) ||
      (body.startsWith("'") && body.endsWith("'"))
    ) {
      body = body.slice(1, -1);
    }
  }

  const ps = [
    "$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::UTF8;",
    body,
  ].join(" ");

  try {
    return await execCapture(exe, [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      ps,
    ], cwd);
  } catch (err) {
    if (preferPwsh) {
      // pwsh missing → Windows PowerShell 5.1
      return runViaPowerShell(`powershell ${body}`, cwd);
    }
    throw err;
  }
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
  const modelRoots = settings.modelRoots || [];
  assertTerminalCwd(
    resolvedCwd,
    settings.fileAccessMode,
    settings.projectRoot,
    modelRoots,
  );

  const allowedRoots = [...modelRoots];
  if (settings.projectRoot) allowedRoots.push(settings.projectRoot);
  assertShellCommandPolicy(rawCmd, allowedRoots);

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
    adapted = adaptCommandForWindows(
      collapseOverEscapedWinPathsInCommand(rawCmd),
      resolvedCwd,
    );
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }
  assertShellCommandPolicy(adapted, allowedRoots);
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

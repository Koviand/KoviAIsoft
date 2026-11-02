import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppSettings } from "@kovi/shared";
import { assertAllowedPath, resolveAgentPath } from "./sandbox.js";
import {
  killProcessTree,
  trackShellPid,
  untrackShellPid,
} from "./terminal.js";

const GIT_TIMEOUT_MS = 120_000;

function requireProjectRoot(settings: AppSettings): string {
  if (!settings.projectRoot) {
    throw new Error("Нужна папка проекта в настройках для git-инструментов");
  }
  const root = path.resolve(settings.projectRoot);
  assertAllowedPath(root, settings.fileAccessMode, settings.projectRoot, settings.modelRoots);
  return root;
}

/** Reject option-injection via leading `-` and odd refs/remotes. */
function assertGitName(value: string, label: string): string {
  const t = value.trim();
  if (!t || t.startsWith("-") || !/^[A-Za-z0-9._/\-]+$/.test(t)) {
    throw new Error(`Некорректный ${label}`);
  }
  return t;
}

function runGit(
  root: string,
  args: string[],
  envExtra?: Record<string, string>,
  opts?: { disableCredentialHelper?: boolean },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const finalArgs =
      opts?.disableCredentialHelper || envExtra?.KOVI_GIT_ASKPASS_TOKEN
        ? ["-c", "credential.helper=", ...args]
        : args;
    const child = spawn("git", finalArgs, {
      cwd: root,
      env: {
        ...process.env,
        ...envExtra,
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "never",
      },
      windowsHide: true,
    });
    trackShellPid(child.pid);
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      untrackShellPid(child.pid);
      fn();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killProcessTree(child.pid);
      child.kill();
      finish(() =>
        reject(new Error(`git превысил лимит ${GIT_TIMEOUT_MS / 1000}с`)),
      );
    }, GIT_TIMEOUT_MS);

    child.stdout?.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", (err) => {
      finish(() => reject(err));
    });
    child.on("close", (code) => {
      if (timedOut) return;
      finish(() =>
        resolve({ code: code ?? 1, stdout: stdout.trimEnd(), stderr: stderr.trimEnd() }),
      );
    });
  });
}

function formatGitResult(label: string, r: { code: number; stdout: string; stderr: string }): string {
  const parts = [`$ git ${label}`, `exit: ${r.code}`];
  if (r.stdout) parts.push(r.stdout);
  if (r.stderr) parts.push(`stderr:\n${r.stderr}`);
  if (r.code !== 0 && !r.stdout && !r.stderr) {
    parts.push("(нет вывода — проверьте, что папка является git-репозиторием)");
  }
  return parts.join("\n");
}

export async function gitStatusTool(settings: AppSettings): Promise<string> {
  const root = requireProjectRoot(settings);
  const r = await runGit(root, ["status", "--porcelain=v1", "-b"]);
  return formatGitResult("status --porcelain=v1 -b", r);
}

export async function gitDiffTool(
  settings: AppSettings,
  opts?: { staged?: boolean; path?: string },
): Promise<string> {
  const root = requireProjectRoot(settings);
  const args = ["diff"];
  if (opts?.staged) args.push("--staged");
  if (opts?.path) {
    const resolved = resolveAgentPath(opts.path, settings.projectRoot);
    assertAllowedPath(resolved, settings.fileAccessMode, settings.projectRoot, settings.modelRoots);
    args.push("--", path.relative(root, resolved) || ".");
  }
  const r = await runGit(root, args);
  return formatGitResult(args.join(" "), r);
}

export async function gitLogTool(settings: AppSettings, n = 15): Promise<string> {
  const root = requireProjectRoot(settings);
  const count = Math.max(1, Math.min(50, Math.floor(n) || 15));
  const r = await runGit(root, ["log", `-n`, String(count), "--oneline", "--decorate"]);
  return formatGitResult(`log -n ${count} --oneline`, r);
}

export async function gitBranchTool(
  settings: AppSettings,
  opts: { action?: string; name?: string } = {},
): Promise<string> {
  const root = requireProjectRoot(settings);
  const action = String(opts.action || "list").toLowerCase();
  if (action === "list" || !opts.name) {
    const r = await runGit(root, ["branch", "-vv"]);
    return formatGitResult("branch -vv", r);
  }
  const name = assertGitName(String(opts.name), "имя ветки");
  if (action === "create") {
    const r = await runGit(root, ["checkout", "-b", name]);
    return formatGitResult(`checkout -b ${name}`, r);
  }
  if (action === "checkout" || action === "switch") {
    const r = await runGit(root, ["checkout", name]);
    return formatGitResult(`checkout ${name}`, r);
  }
  throw new Error(`git_branch: неизвестный action «${action}» (list|create|checkout)`);
}

export async function gitCommitTool(
  settings: AppSettings,
  opts: { message?: string; paths?: unknown },
): Promise<string> {
  const root = requireProjectRoot(settings);
  const message = String(opts.message || "").trim();
  if (!message) throw new Error("git_commit: нужен message");
  const pathsRaw = Array.isArray(opts.paths) ? opts.paths.map(String) : [];
  if (pathsRaw.length) {
    const rels: string[] = [];
    for (const p of pathsRaw) {
      const resolved = resolveAgentPath(p, settings.projectRoot);
      assertAllowedPath(resolved, settings.fileAccessMode, settings.projectRoot, settings.modelRoots);
      rels.push(path.relative(root, resolved) || ".");
    }
    const add = await runGit(root, ["add", "--", ...rels]);
    if (add.code !== 0) return formatGitResult(`add -- ${rels.join(" ")}`, add);
  } else {
    // Exclude local agent checkpoints / index from accidental commits.
    const add = await runGit(root, ["add", "-A", "--", ".", ":(exclude).kovi"]);
    if (add.code !== 0) return formatGitResult("add -A (exclude .kovi)", add);
  }
  const r = await runGit(root, ["commit", "-m", message]);
  return formatGitResult(`commit -m ${JSON.stringify(message)}`, r);
}

/**
 * Askpass helper that reads token from KOVI_GIT_ASKPASS_TOKEN (env of child only).
 * Never embeds the PAT in the script file on disk.
 * On Windows GIT_ASKPASS must be a native/.cmd executable — a bare .js is ignored.
 * Token is only emitted for github.com prompts.
 */
function ensureAskPassScript(): string {
  const jsDest = path.join(os.tmpdir(), "kovi-git-askpass-env.js");
  const script = [
    "#!/usr/bin/env node",
    "const t = process.env.KOVI_GIT_ASKPASS_TOKEN || '';",
    "const q = process.argv.slice(2).join(' ').toLowerCase();",
    "if (q.includes('username')) { process.stdout.write('x-access-token'); process.exit(0); }",
    "if (q.includes('github.com') || (!q.includes('://') && !q.includes('@'))) {",
    "  process.stdout.write(t);",
    "} else {",
    "  process.stdout.write('');",
    "}",
  ].join("\n");
  try {
    if (!fs.existsSync(jsDest) || fs.readFileSync(jsDest, "utf8") !== script) {
      fs.writeFileSync(jsDest, script, "utf8");
    }
  } catch {
    fs.writeFileSync(jsDest, script, "utf8");
  }
  if (process.platform === "win32") {
    const cmdDest = path.join(os.tmpdir(), "kovi-git-askpass-env.cmd");
    const nodeBin = process.execPath.replace(/"/g, "");
    const jsPath = jsDest.replace(/"/g, "");
    const cmd = [
      "@echo off",
      `where node >nul 2>nul && node "${jsPath}" %* && exit /b %ERRORLEVEL%`,
      `set ELECTRON_RUN_AS_NODE=1`,
      `"${nodeBin}" "${jsPath}" %*`,
    ].join("\r\n");
    try {
      if (!fs.existsSync(cmdDest) || fs.readFileSync(cmdDest, "utf8") !== cmd) {
        fs.writeFileSync(cmdDest, cmd, "utf8");
      }
    } catch {
      fs.writeFileSync(cmdDest, cmd, "utf8");
    }
    return cmdDest;
  }
  try {
    fs.chmodSync(jsDest, 0o755);
  } catch {
    /* ignore */
  }
  return jsDest;
}

function gitAskPassEnv(token: string): Record<string, string> {
  const ask = ensureAskPassScript();
  return {
    GIT_ASKPASS: ask,
    SSH_ASKPASS: ask,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    KOVI_GIT_ASKPASS_TOKEN: token,
  };
}

/** Temporary askpass helper for HTTPS push with githubToken. */
export async function gitPushTool(
  settings: AppSettings,
  opts?: { remote?: string; ref?: string },
): Promise<string> {
  const root = requireProjectRoot(settings);
  const remote = assertGitName(String(opts?.remote || "origin").trim() || "origin", "remote");
  const ref = opts?.ref ? assertGitName(String(opts.ref).trim(), "ref") : "";
  const args = ["push", remote];
  if (ref) args.push(ref);

  const token = (settings.githubToken || "").trim();
  let envExtra: Record<string, string> | undefined;
  if (token && token !== "__secure__") {
    envExtra = gitAskPassEnv(token);
  }

  const r = await runGit(root, args, envExtra, { disableCredentialHelper: Boolean(envExtra) });
  return formatGitResult(args.join(" "), r);
}

/** Fast-forward only pull (no auto-merge conflict resolution). */
export async function gitPullTool(
  settings: AppSettings,
  opts?: { remote?: string; ref?: string },
): Promise<string> {
  const root = requireProjectRoot(settings);
  const remote = assertGitName(String(opts?.remote || "origin").trim() || "origin", "remote");
  const ref = opts?.ref ? assertGitName(String(opts.ref).trim(), "ref") : "";
  const args = ["pull", "--ff-only", remote];
  if (ref) args.push(ref);

  const token = (settings.githubToken || "").trim();
  let envExtra: Record<string, string> | undefined;
  if (token && token !== "__secure__") {
    envExtra = gitAskPassEnv(token);
  }

  const r = await runGit(root, args, envExtra, { disableCredentialHelper: Boolean(envExtra) });
  return formatGitResult(args.join(" "), r);
}

/** Check GitHub token via API (or report missing). */
export async function verifyGithubToken(token: string): Promise<{
  ok: boolean;
  login?: string;
  error?: string;
}> {
  const t = token.trim();
  if (!t || t === "__secure__") {
    return { ok: false, error: "Токен не задан" };
  }
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${t}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "KoviAIsoft",
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `GitHub API ${res.status}: ${body.slice(0, 200)}` };
    }
    const data = (await res.json()) as { login?: string };
    return { ok: true, login: data.login };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

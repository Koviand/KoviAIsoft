import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { HfCliStatus } from "@kovi/shared";
import { ensureDir } from "../paths.js";
import type { ProgressFn } from "../runtime/download.js";
import {
  ensureBundledHfCli,
  isBundledHfCliReady,
  resolveBundledHfCli,
} from "./hfBundle.js";

export type HfDownloadMethod = "auto" | "cli" | "http";
export type { HfCliStatus };

interface ResolvedCli {
  command: string;
  prefixArgs: string[];
  mode: NonNullable<HfCliStatus["mode"]>;
  bundled?: boolean;
}

const INSTALL_HINT =
  "Встроенный HF CLI установится автоматически при скачивании модели. Запасной путь — HTTP.";

let installing = false;

function tryVersion(command: string, args: string[]): string | null {
  try {
    const r = spawnSync(command, args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: 8000,
      shell: false,
    });
    const out = `${r.stdout || ""}\n${r.stderr || ""}`.trim();
    if (r.status !== 0 && !out) return null;
    const m = out.match(/(\d+\.\d+(?:\.\d+)?)/);
    return m?.[1] || out.split(/\r?\n/).find(Boolean)?.slice(0, 80) || null;
  } catch {
    return null;
  }
}

function whichExists(bin: string): boolean {
  try {
    const r = spawnSync(process.platform === "win32" ? "where" : "which", [bin], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
      shell: false,
    });
    return r.status === 0 && Boolean((r.stdout || "").trim());
  } catch {
    return false;
  }
}

/** Resolve bundled tools/hf first, then system hf / huggingface-cli / python -m. */
export function resolveHfCli(): ResolvedCli | null {
  const bundled = resolveBundledHfCli();
  if (bundled) {
    return {
      command: bundled.command,
      prefixArgs: bundled.prefixArgs,
      mode: bundled.mode,
      bundled: true,
    };
  }

  if (whichExists("hf")) {
    const ver = tryVersion("hf", ["version"]) || tryVersion("hf", ["--version"]);
    if (ver || whichExists("hf")) {
      return { command: "hf", prefixArgs: [], mode: "hf" };
    }
  }
  if (whichExists("huggingface-cli")) {
    return { command: "huggingface-cli", prefixArgs: [], mode: "huggingface-cli" };
  }
  // python -m huggingface_hub.cli.hf download ...
  for (const py of process.platform === "win32" ? ["py", "python", "python3"] : ["python3", "python"]) {
    if (!whichExists(py) && py !== "py") continue;
    const check = spawnSync(
      py,
      py === "py" ? ["-3", "-m", "huggingface_hub.cli.hf", "version"] : ["-m", "huggingface_hub.cli.hf", "version"],
      { encoding: "utf8", windowsHide: true, timeout: 10000, shell: false },
    );
    const ok =
      check.status === 0 ||
      /usage|huggingface|download/i.test(`${check.stdout || ""}${check.stderr || ""}`);
    // Also try older module path
    if (!ok) {
      const legacy = spawnSync(
        py,
        py === "py"
          ? ["-3", "-m", "huggingface_hub.commands.huggingface_cli", "--help"]
          : ["-m", "huggingface_hub.commands.huggingface_cli", "--help"],
        { encoding: "utf8", windowsHide: true, timeout: 10000, shell: false },
      );
      if (legacy.status === 0 || /download/i.test(`${legacy.stdout || ""}${legacy.stderr || ""}`)) {
        return {
          command: py,
          prefixArgs:
            py === "py"
              ? ["-3", "-m", "huggingface_hub.commands.huggingface_cli"]
              : ["-m", "huggingface_hub.commands.huggingface_cli"],
          mode: "python-module",
        };
      }
      continue;
    }
    return {
      command: py,
      prefixArgs:
        py === "py" ? ["-3", "-m", "huggingface_hub.cli.hf"] : ["-m", "huggingface_hub.cli.hf"],
      mode: "python-module",
    };
  }
  return null;
}

export function getHfCliStatus(): HfCliStatus {
  const resolved = resolveHfCli();
  const bundledReady = isBundledHfCliReady();
  if (!resolved) {
    return {
      available: false,
      binary: null,
      mode: null,
      version: null,
      bundled: false,
      installing,
      hint: installing
        ? "Устанавливается встроенный HF CLI…"
        : INSTALL_HINT,
    };
  }
  const versionArgs =
    resolved.mode === "huggingface-cli"
      ? [...resolved.prefixArgs, "--version"]
      : [...resolved.prefixArgs, "version"];
  const version =
    tryVersion(resolved.command, versionArgs) ||
    tryVersion(resolved.command, [...resolved.prefixArgs, "--version"]);
  return {
    available: true,
    binary: [resolved.command, ...resolved.prefixArgs].join(" "),
    mode: resolved.mode,
    version,
    bundled: Boolean(resolved.bundled || bundledReady),
    installing,
    hint: resolved.bundled
      ? `Встроенный HF CLI готов${version ? ` (${version})` : ""}.`
      : `HF CLI найден (${resolved.mode}${version ? `, ${version}` : ""}).`,
  };
}

/** Install portable HF CLI into tools/hf (no-op if already ready). */
export async function ensureHfCli(onProgress?: ProgressFn): Promise<HfCliStatus> {
  if (isBundledHfCliReady() || resolveHfCli()?.bundled) {
    return getHfCliStatus();
  }
  installing = true;
  try {
    await ensureBundledHfCli({ onProgress });
  } finally {
    installing = false;
  }
  return getHfCliStatus();
}

function parseProgressLine(line: string): number | null {
  // Common patterns: "45%", "Downloading… 45.2%", tqdm style "45%"
  const m = line.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(99, Math.round(n)));
}

/**
 * Download a single repo file via Hugging Face CLI into destDir/modelId__/basename.
 * Returns absolute path to the file.
 */
export async function downloadViaHfCli(
  modelId: string,
  filePath: string,
  destDir: string,
  opts?: {
    token?: string;
    onProgress?: ProgressFn;
  },
): Promise<string> {
  const cli = resolveHfCli();
  if (!cli) {
    throw new Error(`Hugging Face CLI не найден. ${INSTALL_HINT}`);
  }

  ensureDir(destDir);
  const modelDir = path.join(destDir, modelId.replace(/[\\/]/g, "__"));
  ensureDir(modelDir);
  const dest = path.join(modelDir, path.basename(filePath));

  // Fresh download target — remove incomplete previous file
  await fsp.rm(dest, { force: true }).catch(() => undefined);

  const posixFile = filePath.replace(/\\/g, "/");
  const args = [
    ...cli.prefixArgs,
    "download",
    modelId,
    posixFile,
    "--local-dir",
    modelDir,
  ];

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (opts?.token?.trim()) {
    env.HF_TOKEN = opts.token.trim();
    env.HUGGING_FACE_HUB_TOKEN = opts.token.trim();
  }
  // Force UTF-8 progress on Windows where possible
  env.PYTHONUTF8 = "1";
  env.PYTHONIOENCODING = "utf-8";

  opts?.onProgress?.(1, `HF CLI: ${path.basename(filePath)}`);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(cli.command, args, {
      env,
      windowsHide: true,
      shell: false,
    });
    let stderr = "";
    let stdout = "";
    let lastPct = 1;

    const onChunk = (buf: Buffer, isErr: boolean) => {
      const text = buf.toString("utf8");
      if (isErr) stderr += text;
      else stdout += text;
      for (const line of text.split(/\r?\n|\r/)) {
        const pct = parseProgressLine(line);
        if (pct != null && pct >= lastPct) {
          lastPct = pct;
          opts?.onProgress?.(pct, `HF CLI ${pct}% · ${path.basename(filePath)}`);
        }
      }
    };

    child.stdout?.on("data", (b) => onChunk(b, false));
    child.stderr?.on("data", (b) => onChunk(b, true));
    child.on("error", (err) => {
      reject(new Error(`Не удалось запустить HF CLI (${cli.command}): ${err.message}`));
    });
    child.on("close", (code) => {
      if (code === 0) {
        opts?.onProgress?.(99, `HF CLI: проверка файла…`);
        resolve();
        return;
      }
      const detail = (stderr || stdout).trim().slice(-800);
      reject(
        new Error(
          `HF CLI завершился с кодом ${code}${detail ? `: ${detail}` : ""}. ${INSTALL_HINT}`,
        ),
      );
    });
  });

  // CLI may nest as local-dir/file or local-dir/repo/file — find basename
  if (!fs.existsSync(dest)) {
    const found = await findDownloadedFile(modelDir, path.basename(filePath));
    if (found && found !== dest) {
      ensureDir(path.dirname(dest));
      await fsp.rename(found, dest).catch(async () => {
        await fsp.copyFile(found, dest);
      });
    }
  }

  if (!fs.existsSync(dest)) {
    throw new Error(
      `HF CLI отработал, но файл не найден: ${dest}. Проверьте имя файла в репозитории.`,
    );
  }

  opts?.onProgress?.(100, path.basename(dest));
  return dest;
}

async function findDownloadedFile(root: string, baseName: string): Promise<string | null> {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === ".cache" || e.name === ".huggingface") continue;
        stack.push(full);
      } else if (e.isFile() && e.name.toLowerCase() === baseName.toLowerCase()) {
        return full;
      }
    }
  }
  return null;
}

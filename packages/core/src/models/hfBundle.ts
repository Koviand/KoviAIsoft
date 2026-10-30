import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { downloadFile, extractZipTo } from "../runtime/download.js";
import type { ProgressFn } from "../runtime/download.js";
import { ensureDir, getHfToolsDir } from "../paths.js";

/** Windows embeddable CPython — pinned for reproducible portable builds. */
const PY_VERSION = "3.12.7";
const PY_ZIP_NAME = `python-${PY_VERSION}-embed-amd64.zip`;
const PY_ZIP_URL = `https://www.python.org/ftp/python/${PY_VERSION}/${PY_ZIP_NAME}`;
const GET_PIP_URL = "https://bootstrap.pypa.io/get-pip.py";
/** Minimum plausible size for the embed zip (guards truncated downloads). */
const PY_ZIP_MIN_BYTES = 8_000_000;

let ensurePromise: Promise<string> | null = null;

export function bundledHfPythonPath(toolsDir = getHfToolsDir()): string {
  return path.join(toolsDir, "python", "python.exe");
}

export function bundledHfCmdPath(toolsDir = getHfToolsDir()): string {
  return path.join(toolsDir, "hf.cmd");
}

export function isBundledHfCliReady(toolsDir = getHfToolsDir()): boolean {
  const py = bundledHfPythonPath(toolsDir);
  const marker = path.join(toolsDir, ".hf-ready");
  return fs.existsSync(py) && fs.existsSync(marker);
}

function runProcess(
  command: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; onLine?: (line: string) => void },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", ...(opts.env || {}) },
      windowsHide: true,
      shell: false,
    });
    let err = "";
    const feed = (buf: Buffer) => {
      const text = buf.toString("utf8");
      err += text;
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) opts.onLine?.(line);
      }
    };
    child.stdout?.on("data", feed);
    child.stderr?.on("data", feed);
    child.on("error", (e) => reject(e));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(command)} ${args.slice(-3).join(" ")} → exit ${code}\n${err.slice(-1200)}`));
    });
  });
}

async function enableSitePackages(pythonDir: string): Promise<void> {
  const entries = await fsp.readdir(pythonDir);
  const pth = entries.find((e) => e.endsWith("._pth"));
  if (!pth) return;
  const full = path.join(pythonDir, pth);
  let text = await fsp.readFile(full, "utf8");
  text = text.replace(/^#\s*import\s+site\s*$/m, "import site");
  if (!/^import\s+site\s*$/m.test(text)) {
    text = `${text.trimEnd()}\nimport site\n`;
  }
  if (!/Lib\\site-packages|Lib\/site-packages/.test(text)) {
    text = `${text.trimEnd()}\nLib\\site-packages\n`;
  }
  await fsp.writeFile(full, text, "utf8");
}

async function writeHfWrapper(toolsDir: string, pythonExe: string): Promise<void> {
  const hfExe = path.join(path.dirname(pythonExe), "Scripts", "hf.exe");
  const cmd = bundledHfCmdPath(toolsDir);
  const body = fs.existsSync(hfExe)
    ? `@echo off\r\n"${hfExe}" %*\r\n`
    : `@echo off\r\n"${pythonExe}" -m huggingface_hub.cli.hf %*\r\n`;
  await fsp.writeFile(cmd, body, "utf8");
}

/**
 * Embeddable CPython has no stdlib `venv`. Recent huggingface_hub CLI imports it
 * on unknown commands — ship a no-op stub so `hf download` works.
 */
async function ensureVenvStub(pythonDir: string): Promise<void> {
  const stubDir = path.join(pythonDir, "Lib", "site-packages", "venv");
  ensureDir(stubDir);
  const init = path.join(stubDir, "__init__.py");
  if (!fs.existsSync(init)) {
    await fsp.writeFile(
      init,
      "# Stub: embeddable Python lacks stdlib venv; HF CLI only imports it for extensions.\n",
      "utf8",
    );
  }
}

async function probeHfCli(pythonExe: string, pythonDir: string): Promise<{
  command: string;
  prefixArgs: string[];
}> {
  await ensureVenvStub(pythonDir);
  const hfExe = path.join(pythonDir, "Scripts", "hf.exe");
  if (fs.existsSync(hfExe)) {
    await runProcess(hfExe, ["download", "--help"], { cwd: pythonDir });
    return { command: hfExe, prefixArgs: [] };
  }
  await runProcess(pythonExe, ["-m", "huggingface_hub.cli.hf", "download", "--help"], {
    cwd: pythonDir,
  });
  return { command: pythonExe, prefixArgs: ["-m", "huggingface_hub.cli.hf"] };
}

/**
 * Ensure portable HF CLI exists under tools/hf (embeddable Python + huggingface_hub).
 * Returns path to hf.cmd wrapper.
 */
export async function ensureBundledHfCli(opts?: {
  toolsDir?: string;
  onProgress?: ProgressFn;
}): Promise<string> {
  const toolsDir = opts?.toolsDir || getHfToolsDir();
  if (isBundledHfCliReady(toolsDir)) {
    return bundledHfCmdPath(toolsDir);
  }
  if (ensurePromise) return ensurePromise;

  ensurePromise = (async () => {
    ensureDir(toolsDir);
    const onProgress = opts?.onProgress;
    const pythonDir = path.join(toolsDir, "python");
    const zipPath = path.join(toolsDir, PY_ZIP_NAME);
    const getPip = path.join(toolsDir, "get-pip.py");

    try {
      if (!fs.existsSync(bundledHfPythonPath(toolsDir))) {
        onProgress?.(5, "HF CLI: скачивание Python…");
        await downloadFile(PY_ZIP_URL, zipPath, (p, label) => {
          onProgress?.(5 + Math.round(p * 0.25), `HF CLI Python: ${label}`);
        });
        const st = await fsp.stat(zipPath);
        if (st.size < PY_ZIP_MIN_BYTES) {
          throw new Error(`Подозрительно маленький Python zip (${st.size} bytes)`);
        }
        onProgress?.(35, "HF CLI: распаковка Python…");
        await fsp.rm(pythonDir, { recursive: true, force: true }).catch(() => undefined);
        ensureDir(pythonDir);
        await extractZipTo(zipPath, pythonDir);
        await enableSitePackages(pythonDir);
        await fsp.rm(zipPath, { force: true }).catch(() => undefined);
      }

      const pythonExe = bundledHfPythonPath(toolsDir);
      if (!fs.existsSync(pythonExe)) {
        throw new Error(`python.exe не найден после распаковки: ${pythonExe}`);
      }

      const hasPip =
        fs.existsSync(path.join(pythonDir, "Scripts", "pip.exe")) ||
        fs.existsSync(path.join(pythonDir, "Lib", "site-packages", "pip"));
      if (!hasPip) {
        onProgress?.(45, "HF CLI: установка pip…");
        await downloadFile(GET_PIP_URL, getPip, (p) => {
          onProgress?.(45 + Math.round(p * 0.1), "get-pip.py");
        });
        await runProcess(pythonExe, [getPip, "--no-warn-script-location"], {
          cwd: pythonDir,
          onLine: (line) => onProgress?.(55, `pip: ${line.slice(0, 80)}`),
        });
        await fsp.rm(getPip, { force: true }).catch(() => undefined);
      }

      onProgress?.(60, "HF CLI: установка huggingface_hub…");
      await runProcess(
        pythonExe,
        ["-m", "pip", "install", "--upgrade", "--no-warn-script-location", "huggingface_hub[cli]"],
        {
          cwd: pythonDir,
          onLine: (line) => {
            if (/Successfully|Requirement|Installing|Downloading/i.test(line)) {
              onProgress?.(70, line.slice(0, 100));
            }
          },
        },
      );

      onProgress?.(90, "HF CLI: проверка…");
      await ensureVenvStub(pythonDir);
      const probed = await probeHfCli(pythonExe, pythonDir);
      await writeHfWrapper(toolsDir, pythonExe);
      await fsp.writeFile(
        path.join(toolsDir, ".hf-ready"),
        JSON.stringify({
          readyAt: new Date().toISOString(),
          py: PY_VERSION,
          command: probed.command,
          prefixArgs: probed.prefixArgs,
        }),
        "utf8",
      );
      onProgress?.(100, "HF CLI готов");
      return bundledHfCmdPath(toolsDir);
    } catch (err) {
      await fsp.rm(path.join(toolsDir, ".hf-ready"), { force: true }).catch(() => undefined);
      throw err instanceof Error
        ? err
        : new Error(`Не удалось установить встроенный HF CLI: ${String(err)}`);
    } finally {
      ensurePromise = null;
    }
  })();

  return ensurePromise;
}

/** Resolve bundled CLI (prefer Scripts/hf.exe). */
export function resolveBundledHfCli(toolsDir = getHfToolsDir()): {
  command: string;
  prefixArgs: string[];
  mode: "hf";
  bundled: true;
} | null {
  if (!isBundledHfCliReady(toolsDir)) return null;
  const py = bundledHfPythonPath(toolsDir);
  const hfExe = path.join(path.dirname(py), "Scripts", "hf.exe");
  try {
    const raw = fs.readFileSync(path.join(toolsDir, ".hf-ready"), "utf8");
    const j = JSON.parse(raw) as { command?: string; prefixArgs?: string[] };
    if (j.command && fs.existsSync(j.command)) {
      return {
        command: j.command,
        prefixArgs: Array.isArray(j.prefixArgs) ? j.prefixArgs : [],
        mode: "hf",
        bundled: true,
      };
    }
  } catch {
    // fall through
  }
  if (fs.existsSync(hfExe)) {
    return { command: hfExe, prefixArgs: [], mode: "hf", bundled: true };
  }
  return {
    command: py,
    prefixArgs: ["-m", "huggingface_hub.cli.hf"],
    mode: "hf",
    bundled: true,
  };
}

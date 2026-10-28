import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type {
  GenerationParams,
  InstalledRuntime,
  LocalModel,
  RuntimeAsset,
  RuntimeBackend,
  RuntimeStatus,
  RuntimeUpdateInfo,
} from "@kovi/shared";
import { getRuntimesDir } from "../paths.js";
import {
  fetchLatestRuntimeAsset,
  isNewerRuntime,
  parseBuildNumber,
} from "./assets.js";
import {
  downloadFile,
  extractZipTo,
  findLlamaServer,
  mergeDirectory,
  type ProgressFn,
} from "./download.js";
import { detectSystemInfo } from "../system/detect.js";

async function findFreePort(start = 8080): Promise<number> {
  for (let port = start; port < start + 200; port++) {
    const free = await new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.once("listening", () => {
        server.close(() => resolve(true));
      });
      server.listen(port, "127.0.0.1");
    });
    if (free) return port;
  }
  throw new Error("Не удалось найти свободный порт для llama-server");
}

async function waitForServer(port: number, timeoutMs = 120_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/models`);
      if (res.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("llama-server не ответил вовремя");
}

export class RuntimeManager {
  private appData: string;
  private installed: InstalledRuntime | null = null;
  private process: ChildProcessWithoutNullStreams | null = null;
  private port: number | null = null;
  private loadedModelId: string | null = null;
  private downloading = false;
  private downloadProgress = 0;
  private downloadLabel = "";
  private lastError: string | null = null;
  private updateInfo: RuntimeUpdateInfo | null = null;
  private onProgress?: ProgressFn;
  private ensurePromise: Promise<{
    updated: boolean;
    installed: InstalledRuntime;
    update: RuntimeUpdateInfo;
  }> | null = null;

  constructor(appData: string) {
    this.appData = appData;
    this.installed = this.readInstalledMeta();
  }

  setProgressHandler(fn: ProgressFn): void {
    this.onProgress = fn;
  }

  getStatus(): RuntimeStatus {
    return {
      installed: this.installed,
      downloading: this.downloading,
      downloadProgress: this.downloadProgress,
      downloadLabel: this.downloadLabel,
      serverRunning: Boolean(this.process && !this.process.killed),
      serverPort: this.port,
      loadedModelId: this.loadedModelId,
      lastError: this.lastError,
      update: this.updateInfo,
    };
  }

  getOpenAiBaseUrl(): string | null {
    if (!this.port) return null;
    return `http://127.0.0.1:${this.port}/v1`;
  }

  private metaPath(): string {
    return path.join(getRuntimesDir(this.appData), "installed.json");
  }

  private runtimesRoot(): string {
    return getRuntimesDir(this.appData);
  }

  /** Resolve stored (possibly relative) paths to absolute ones that exist. */
  private hydrateMeta(raw: InstalledRuntime): InstalledRuntime | null {
    const root = this.runtimesRoot();
    const absPath = path.isAbsolute(raw.path) ? raw.path : path.join(root, raw.path);
    let absServer = path.isAbsolute(raw.serverPath)
      ? raw.serverPath
      : path.join(root, raw.serverPath);

    if (!fs.existsSync(absServer)) {
      // Fallback: search inside install folder (portable move / renamed layout).
      if (fs.existsSync(absPath)) {
        const found = fs.existsSync(path.join(absPath, "llama-server.exe"))
          ? path.join(absPath, "llama-server.exe")
          : null;
        if (found) absServer = found;
      }
    }
    if (!fs.existsSync(absServer)) return null;

    return {
      ...raw,
      path: absPath,
      serverPath: absServer,
    };
  }

  private toStoredMeta(meta: InstalledRuntime): InstalledRuntime {
    const root = this.runtimesRoot();
    const relPath = path.isAbsolute(meta.path)
      ? path.relative(root, meta.path) || path.basename(meta.path)
      : meta.path;
    const relServer = path.isAbsolute(meta.serverPath)
      ? path.relative(root, meta.serverPath)
      : meta.serverPath;
    return {
      ...meta,
      path: relPath.replace(/\\/g, "/"),
      serverPath: relServer.replace(/\\/g, "/"),
    };
  }

  private readInstalledMeta(): InstalledRuntime | null {
    try {
      const raw = fs.readFileSync(this.metaPath(), "utf8");
      const meta = JSON.parse(raw) as InstalledRuntime;
      return this.hydrateMeta(meta);
    } catch {
      return null;
    }
  }

  private async writeInstalledMeta(meta: InstalledRuntime): Promise<void> {
    const hydrated = this.hydrateMeta(meta) || meta;
    await fsp.writeFile(
      this.metaPath(),
      JSON.stringify(this.toStoredMeta(hydrated), null, 2),
      "utf8",
    );
    this.installed = hydrated;
  }

  /** Ensure in-memory installed points at a real binary; re-read from disk if needed. */
  refreshInstalled(): InstalledRuntime | null {
    this.installed = this.readInstalledMeta();
    return this.installed;
  }

  async detectAsset(backendPref: RuntimeBackend | "auto" = "auto"): Promise<RuntimeAsset> {
    const sys = await detectSystemInfo(backendPref);
    const backend =
      backendPref === "auto" ? sys.recommendedBackend : backendPref;
    return fetchLatestRuntimeAsset(backend, sys.cudaVersion);
  }

  async checkUpdate(backendPref: RuntimeBackend | "auto" = "auto"): Promise<RuntimeUpdateInfo> {
    try {
      if (!this.installed) this.refreshInstalled();
      const latest = await this.detectAsset(backendPref);
      const currentTag = this.installed?.tag ?? null;
      const backendMismatch =
        Boolean(this.installed) && this.installed!.backend !== latest.backend;
      const updateAvailable =
        !this.installed ||
        backendMismatch ||
        isNewerRuntime(latest.tag, currentTag);

      const info: RuntimeUpdateInfo = {
        updateAvailable,
        currentTag,
        latestTag: latest.tag,
        latestAsset: latest,
        checkedAt: new Date().toISOString(),
        message: !this.installed
          ? `Runtime не установлен. Доступен ${latest.tag} (${latest.backend}).`
          : updateAvailable
            ? `Доступно обновление: ${currentTag || "?"} → ${latest.tag} (${latest.backend}).`
            : `Установлена актуальная версия ${latest.tag}.`,
      };
      this.updateInfo = info;
      return info;
    } catch (err) {
      const info: RuntimeUpdateInfo = {
        updateAvailable: false,
        currentTag: this.installed?.tag ?? null,
        latestTag: null,
        latestAsset: null,
        checkedAt: new Date().toISOString(),
        message: err instanceof Error ? err.message : String(err),
      };
      this.updateInfo = info;
      this.lastError = info.message;
      return info;
    }
  }

  async ensureLatest(
    backendPref: RuntimeBackend | "auto" = "auto",
    opts: { force?: boolean } = {},
  ): Promise<{ updated: boolean; installed: InstalledRuntime; update: RuntimeUpdateInfo }> {
    if (this.ensurePromise) return this.ensurePromise;
    this.ensurePromise = this.ensureLatestInner(backendPref, opts).finally(() => {
      this.ensurePromise = null;
    });
    return this.ensurePromise;
  }

  private async ensureLatestInner(
    backendPref: RuntimeBackend | "auto",
    opts: { force?: boolean },
  ): Promise<{ updated: boolean; installed: InstalledRuntime; update: RuntimeUpdateInfo }> {
    if (!this.installed) this.refreshInstalled();
    const update = await this.checkUpdate(backendPref);
    if (!update.latestAsset) {
      if (this.installed) {
        return { updated: false, installed: this.installed, update };
      }
      throw new Error(update.message || "Не удалось определить latest llama.cpp");
    }

    if (!opts.force && !update.updateAvailable && this.installed) {
      return { updated: false, installed: this.installed, update };
    }

    const previousModelId = this.loadedModelId;
    await this.stopServer();

    const installed = await this.install(backendPref, update.latestAsset);
    const refreshed: RuntimeUpdateInfo = {
      ...update,
      updateAvailable: false,
      currentTag: installed.tag,
      message: `Установлен llama.cpp ${installed.tag} (${installed.backend}).`,
      checkedAt: new Date().toISOString(),
    };
    this.updateInfo = refreshed;

    if (previousModelId) {
      this.downloadLabel = `Runtime обновлён. Перезагрузите модель.`;
    }

    return { updated: true, installed, update: refreshed };
  }

  /**
   * Install if missing. Does not hit GitHub when a valid runtime is already present.
   */
  async ensureInstalled(
    backendPref: RuntimeBackend | "auto" = "auto",
  ): Promise<InstalledRuntime> {
    if (!this.installed) this.refreshInstalled();
    if (this.installed && fs.existsSync(this.installed.serverPath)) {
      return this.installed;
    }
    return this.install(backendPref);
  }

  async install(
    backendPref: RuntimeBackend | "auto" = "auto",
    preselected?: RuntimeAsset,
  ): Promise<InstalledRuntime> {
    if (this.downloading) {
      throw new Error("Уже идёт скачивание runtime");
    }
    this.downloading = true;
    this.downloadProgress = 0;
    this.lastError = null;
    try {
      const asset = preselected || (await this.detectAsset(backendPref));
      const destRoot = path.join(
        this.runtimesRoot(),
        `${asset.tag}-${asset.backend}`,
      );

      const existingServer = await findLlamaServer(destRoot);
      if (existingServer) {
        const meta: InstalledRuntime = {
          tag: asset.tag,
          backend: asset.backend,
          path: destRoot,
          serverPath: existingServer,
          installedAt: new Date().toISOString(),
        };
        await this.writeInstalledMeta(meta);
        this.downloadProgress = 100;
        this.downloadLabel = `Уже установлен ${meta.tag}`;
        this.onProgress?.(100, this.downloadLabel);
        this.updateInfo = {
          updateAvailable: false,
          currentTag: meta.tag,
          latestTag: meta.tag,
          latestAsset: asset,
          checkedAt: new Date().toISOString(),
          message: `Установлен llama.cpp ${meta.tag} (${meta.backend}).`,
        };
        return meta;
      }

      const tmp = path.join(this.runtimesRoot(), "_tmp");
      await fsp.rm(tmp, { recursive: true, force: true });
      fs.mkdirSync(tmp, { recursive: true });

      const staging = path.join(tmp, "stage");
      fs.mkdirSync(staging, { recursive: true });

      const zipPath = path.join(tmp, asset.assetName);
      this.downloadLabel = `Скачивание ${asset.assetName}`;
      await downloadFile(
        asset.url,
        zipPath,
        (p, label) => {
          this.downloadProgress = Math.round(p * 0.7);
          this.downloadLabel = label;
          this.onProgress?.(this.downloadProgress, this.downloadLabel);
        },
        asset.sha256,
        asset.size,
      );

      this.downloadLabel = "Распаковка runtime";
      this.downloadProgress = 72;
      this.onProgress?.(72, this.downloadLabel);
      const extractDir = path.join(tmp, "extract");
      await extractZipTo(zipPath, extractDir);
      await mergeDirectory(extractDir, staging);

      if (asset.cudartUrl && asset.cudartAssetName) {
        const cudartZip = path.join(tmp, asset.cudartAssetName);
        this.downloadLabel = `Скачивание ${asset.cudartAssetName}`;
        await downloadFile(
          asset.cudartUrl,
          cudartZip,
          (p, label) => {
            this.downloadProgress = 75 + Math.round(p * 0.15);
            this.downloadLabel = label;
            this.onProgress?.(this.downloadProgress, this.downloadLabel);
          },
          asset.cudartSha256,
          asset.cudartSize,
        );
        const cudartExtract = path.join(tmp, "cudart");
        await extractZipTo(cudartZip, cudartExtract);
        await mergeDirectory(cudartExtract, staging);
      }

      const stagedServer = await findLlamaServer(staging);
      if (!stagedServer) {
        throw new Error("llama-server.exe не найден после установки");
      }

      // Atomic-ish swap: only wipe dest after staging is valid.
      await fsp.rm(destRoot, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(destRoot), { recursive: true });
      await fsp.rename(staging, destRoot).catch(async () => {
        await mergeDirectory(staging, destRoot);
      });

      const serverPath = await findLlamaServer(destRoot);
      if (!serverPath) {
        throw new Error("llama-server.exe не найден после установки");
      }

      const meta: InstalledRuntime = {
        tag: asset.tag,
        backend: asset.backend,
        path: destRoot,
        serverPath,
        installedAt: new Date().toISOString(),
      };
      await this.writeInstalledMeta(meta);
      await this.cleanupOldRuntimes(meta);
      await fsp.rm(tmp, { recursive: true, force: true });
      this.downloadProgress = 100;
      this.downloadLabel = `Установлен ${meta.tag}`;
      this.onProgress?.(100, this.downloadLabel);
      this.updateInfo = {
        updateAvailable: false,
        currentTag: meta.tag,
        latestTag: meta.tag,
        latestAsset: asset,
        checkedAt: new Date().toISOString(),
        message: `Установлен llama.cpp ${meta.tag} (${meta.backend}).`,
      };
      return meta;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      this.downloading = false;
    }
  }

  private async cleanupOldRuntimes(keep: InstalledRuntime): Promise<void> {
    const root = this.runtimesRoot();
    let entries: fs.Dirent[] = [];
    try {
      entries = await fsp.readdir(root, { withFileTypes: true });
    } catch {
      return;
    }
    const keepName = path.basename(keep.path);
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === "_tmp" || e.name === keepName) continue;
      if (!/^b\d+-(cuda|vulkan|cpu)$/i.test(e.name)) continue;
      const full = path.join(root, e.name);
      try {
        await fsp.rm(full, { recursive: true, force: true });
      } catch {
        // ignore locked dirs
      }
    }
  }

  async stopServer(): Promise<void> {
    if (!this.process) {
      this.port = null;
      this.loadedModelId = null;
      return;
    }
    const proc = this.process;
    this.process = null;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // ignore
        }
        resolve();
      }, 5000);
      proc.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
      try {
        proc.kill();
      } catch {
        clearTimeout(t);
        resolve();
      }
    });
    this.port = null;
    this.loadedModelId = null;
  }

  async loadModel(model: LocalModel, params: GenerationParams): Promise<void> {
    if (!this.installed) {
      this.refreshInstalled();
    }
    if (!this.installed || !fs.existsSync(this.installed.serverPath)) {
      throw new Error("Runtime llama.cpp не установлен");
    }
    await this.stopServer();
    const port = await findFreePort(8080);
    const args = [
      "-m",
      model.path,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "-c",
      String(params.context),
      "-ngl",
      String(params.gpuLayers),
      "--alias",
      model.name,
      "--jinja",
      "--no-webui",
    ];
    if (model.mmprojPath) {
      args.push("--mmproj", model.mmprojPath);
    }

    const cwd = path.dirname(this.installed.serverPath);
    const child = spawn(this.installed.serverPath, args, {
      cwd,
      windowsHide: true,
      env: { ...process.env },
    });
    this.process = child;
    this.port = port;
    this.loadedModelId = model.id;
    this.lastError = null;

    let stderr = "";
    child.stderr.on("data", (buf: Buffer) => {
      stderr += buf.toString();
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
    });
    child.on("exit", (code) => {
      if (this.process === child) {
        this.process = null;
        this.port = null;
        this.loadedModelId = null;
        if (code && code !== 0) {
          this.lastError = `llama-server завершился с кодом ${code}. ${stderr.slice(-500)}`;
        }
      }
    });

    try {
      await waitForServer(port);
    } catch (err) {
      await this.stopServer();
      this.lastError =
        (err instanceof Error ? err.message : String(err)) +
        (stderr ? `\n${stderr.slice(-800)}` : "");
      throw new Error(this.lastError);
    }
  }
}

export { parseBuildNumber };

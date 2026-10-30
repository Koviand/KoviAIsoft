import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { type ChildProcess, spawn } from "node:child_process";
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
  private process: ChildProcess | null = null;
  private port: number | null = null;
  private loadedModelId: string | null = null;
  private loadedContext: number | null = null;
  private loadedGpuLayers: number | null = null;
  private downloading = false;
  private downloadProgress = 0;
  private downloadLabel = "";
  private lastError: string | null = null;
  /** Ring buffer of recent llama-server stdout/stderr for diagnostics. */
  private serverLog = "";
  private updateInfo: RuntimeUpdateInfo | null = null;
  /**
   * Cached llama-server constraint support for agent JSON
   * (null = unknown, try; false = failed previously this process).
   */
  jsonSchemaOk: boolean | null = null;
  grammarOk: boolean | null = null;
  private onProgress?: ProgressFn;
  private ensurePromise: Promise<{
    updated: boolean;
    installed: InstalledRuntime;
    update: RuntimeUpdateInfo;
  }> | null = null;
  private installPromise: Promise<InstalledRuntime> | null = null;

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
      loadedContext: this.loadedModelId ? this.loadedContext : null,
      loadedGpuLayers: this.loadedModelId ? this.loadedGpuLayers : null,
      lastError: this.lastError,
      update: this.updateInfo,
    };
  }

  getOpenAiBaseUrl(): string | null {
    if (!this.isProcessAlive() || !this.port) return null;
    return `http://127.0.0.1:${this.port}/v1`;
  }

  private clearLoadedModel(): void {
    this.loadedModelId = null;
    this.loadedContext = null;
    this.loadedGpuLayers = null;
  }

  /** True when we still have a live llama-server child process. */
  isProcessAlive(): boolean {
    const proc = this.process;
    if (!proc || proc.killed) return false;
    // exitCode set after process exit; null while running.
    if (proc.exitCode != null) return false;
    return true;
  }

  private appendServerLog(chunk: string): void {
    this.serverLog += chunk;
    if (this.serverLog.length > 40_000) {
      this.serverLog = this.serverLog.slice(-40_000);
    }
  }

  getServerLogTail(max = 800): string {
    return this.serverLog.slice(-max);
  }

  /**
   * Ensure OpenAI endpoint is reachable. Clears stale port if process died.
   * Throws a Russian actionable error for the UI/agent.
   */
  async assertLlmReady(): Promise<string> {
    if (!this.isProcessAlive() || !this.port) {
      this.port = null;
      this.clearLoadedModel();
      this.process = null;
      const hint = this.lastError ? ` Последняя ошибка runtime: ${this.lastError}` : "";
      throw new Error(
        `Модель не загружена или llama-server не запущен.${hint} Откройте «Модели» → «Загрузить в память».`,
      );
    }
    const port = this.port;
    const bases = [`http://127.0.0.1:${port}/v1`, `http://localhost:${port}/v1`];
    const probes = [
      (base: string) => `${base.replace(/\/v1$/, "")}/health`,
      (base: string) => `${base}/models`,
    ];
    let lastDetail = "";
    // Longer budget: Vulkan can stall briefly under load; short 2.5s probes false-negative.
    for (let attempt = 0; attempt < 8; attempt++) {
      if (!this.isProcessAlive()) break;
      for (const base of bases) {
        for (const makeUrl of probes) {
          try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 8_000);
            const res = await fetch(makeUrl(base), { signal: ctrl.signal });
            clearTimeout(t);
            if (res.ok) return base;
            lastDetail = `HTTP ${res.status} @ ${makeUrl(base)}`;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const cause =
              err instanceof Error && "cause" in err && err.cause instanceof Error
                ? err.cause.message
                : "";
            lastDetail = cause ? `${msg} (${cause})` : msg;
          }
        }
      }
      await new Promise((r) => setTimeout(r, 500 + attempt * 200));
    }

    const logTail = this.getServerLogTail(600);
    const runtimeErr = this.lastError ? ` Runtime: ${this.lastError}` : "";
    // Process looks alive but HTTP is dead — usually stalled pipe or crashed worker.
    if (this.isProcessAlive()) {
      this.lastError =
        `llama-server не отвечает на порту ${port} (${lastDetail}).${runtimeErr}` +
        (logTail ? ` Лог: …${logTail}` : "");
    } else {
      this.port = null;
      this.clearLoadedModel();
      this.process = null;
    }
    throw new Error(
      `Нет связи с локальной моделью (порт ${port}): ${lastDetail}.${runtimeErr} ` +
        `Нажмите «Загрузить в память» снова. Если падает сразу — профиль «Мало VRAM» или «Только CPU».` +
        (logTail ? ` Детали: ${logTail.slice(-300)}` : ""),
    );
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

    if (!fs.existsSync(absServer) && fs.existsSync(absPath)) {
      // Sync walk — same as findLlamaServer but without async for hydrate.
      const stack = [absPath];
      while (stack.length && !fs.existsSync(absServer)) {
        const dir = stack.pop()!;
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of entries) {
          const full = path.join(dir, e.name);
          if (e.isFile() && e.name.toLowerCase() === "llama-server.exe") {
            absServer = full;
            break;
          }
          if (e.isDirectory() && e.name !== "node_modules") stack.push(full);
        }
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
    let relPath = path.isAbsolute(meta.path)
      ? path.relative(root, meta.path)
      : meta.path;
    let relServer = path.isAbsolute(meta.serverPath)
      ? path.relative(root, meta.serverPath)
      : meta.serverPath;
    // Avoid storing paths that escape the runtimes root (other drive / ..).
    if (!relPath || relPath.startsWith("..") || path.isAbsolute(relPath)) {
      relPath = path.basename(meta.path);
    }
    if (!relServer || relServer.startsWith("..") || path.isAbsolute(relServer)) {
      relServer = path.join(path.basename(meta.path), path.basename(meta.serverPath));
    }
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
    const hydrated = this.hydrateMeta(meta);
    if (!hydrated) {
      throw new Error("Не удалось сохранить runtime: llama-server.exe не найден");
    }
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
    // Coalesce only non-force checks; force always starts a dedicated pass after in-flight ends.
    if (this.ensurePromise && !opts.force) return this.ensurePromise;
    if (this.ensurePromise && opts.force) {
      await this.ensurePromise.catch(() => undefined);
    }
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

    // Never tear down a running model for a quiet background update.
    if (!opts.force && this.process && !this.process.killed) {
      const deferred: RuntimeUpdateInfo = {
        ...update,
        message: `Доступно обновление ${update.latestTag}, отложено пока загружена модель.`,
      };
      this.updateInfo = deferred;
      return { updated: false, installed: this.installed!, update: deferred };
    }

    const previousModelId = this.loadedModelId;
    await this.stopServer();

    const installed = await this.install(backendPref, update.latestAsset, {
      force: Boolean(opts.force),
    });
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
    opts: { force?: boolean } = {},
  ): Promise<InstalledRuntime> {
    if (this.installPromise) {
      if (!opts.force) return this.installPromise;
      await this.installPromise.catch(() => undefined);
    }
    this.installPromise = this.installInner(backendPref, preselected, opts).finally(() => {
      this.installPromise = null;
    });
    return this.installPromise;
  }

  private async installInner(
    backendPref: RuntimeBackend | "auto",
    preselected: RuntimeAsset | undefined,
    opts: { force?: boolean },
  ): Promise<InstalledRuntime> {
    this.downloading = true;
    this.downloadProgress = 0;
    this.lastError = null;
    try {
      const asset = preselected || (await this.detectAsset(backendPref));
      const destRoot = path.join(
        this.runtimesRoot(),
        `${asset.tag}-${asset.backend}`,
      );

      if (opts.force) {
        await fsp.rm(destRoot, { recursive: true, force: true });
      }

      const existingServer = await findLlamaServer(destRoot);
      if (existingServer && !opts.force) {
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
    this.jsonSchemaOk = null;
    this.grammarOk = null;
    if (!this.process) {
      this.port = null;
      this.clearLoadedModel();
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
    this.clearLoadedModel();
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
    if (model.integrityOk === false) {
      throw new Error(
        `Модель не прошла проверку GGUF: ${model.integrityError || "повреждённый файл"}`,
      );
    }
    if (model.fitsInVram === false && params.gpuLayers > 0) {
      // Soft warning into lastError after start; still allow load with profile override.
      console.warn(
        `Модель ${model.name} может не влезть в VRAM (ngl=${params.gpuLayers}, ctx=${params.context}).`,
      );
    }
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
      // Keep HTTP accept queue responsive while a completion is running.
      "--threads-http",
      "4",
      "--alias",
      model.name,
      "--jinja",
      "--no-webui",
    ];
    if (params.flashAttn) {
      args.push("-fa");
    }
    if (model.mmprojPath) {
      args.push("--mmproj", model.mmprojPath);
    }

    const cwd = path.dirname(this.installed.serverPath);
    // CRITICAL on Windows: default piped stdout fills (~64KB) and freezes llama-server
    // if nobody reads it — HTTP then looks like "fetch failed" while the process is "alive".
    const child = spawn(this.installed.serverPath, args, {
      cwd,
      windowsHide: true,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.process = child;
    this.port = port;
    this.loadedModelId = model.id;
    this.loadedContext = params.context;
    this.loadedGpuLayers = params.gpuLayers;
    this.lastError = null;
    this.serverLog = "";

    const onChunk = (buf: Buffer) => this.appendServerLog(buf.toString());
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    child.on("error", (err) => {
      this.appendServerLog(`\n[spawn error] ${err.message}\n`);
      this.lastError = `Не удалось запустить llama-server: ${err.message}`;
    });
    child.on("exit", (code, signal) => {
      if (this.process === child) {
        this.process = null;
        this.port = null;
        this.clearLoadedModel();
        const tail = this.getServerLogTail(500);
        if (code && code !== 0) {
          this.lastError = `llama-server завершился с кодом ${code}. ${tail}`;
        } else if (signal) {
          this.lastError = `llama-server остановлен (${signal}). ${tail}`;
        }
      }
    });

    try {
      await waitForServer(port);
    } catch (err) {
      const log = this.serverLog;
      await this.stopServer();
      const oom =
        /out of memory|cuda.?error|failed to allocate|ggml_cuda|VRAM|insufficient|vk::|vulkan/i.test(
          log,
        );
      const base =
        (err instanceof Error ? err.message : String(err)) +
        (log ? `\n${log.slice(-800)}` : "");
      this.lastError = oom
        ? `Нехватка VRAM/памяти при загрузке модели. Выберите профиль «Мало VRAM» или «Только CPU».\n${base}`
        : base;
      throw new Error(this.lastError);
    }
  }
}

export { parseBuildNumber };

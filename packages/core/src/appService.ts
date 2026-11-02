import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AppSettings,
  ChatAttachment,
  ChatMessage,
  ChatSession,
  CodebaseIndexStatus,
  EmbeddingModelId,
  EmbeddingModelInfo,
  EmbeddingStatus,
  GenerationParams,
  HfFile,
  HfSearchResult,
  InstalledRuntime,
  LocalModel,
  McpHealthResult,
  McpServerConfig,
  ModelRecommendationsReport,
  SessionPatch,
  MonitorSnapshot,
  RuntimeAsset,
  RuntimeBackend,
  RuntimeStatus,
  SessionExportBundle,
  StatusBarInfo,
  SystemInfo,
} from "@kovi/shared";
import {
  AUTO_PC_PROFILE_ID,
  DEFAULT_GENERATION_PARAMS,
  sessionToolsEnabled,
  type ApplyLoadSettingsResult,
  type HardwareLoadSuggestion,
} from "@kovi/shared";
import {
  detectAgentTask,
  detectLiveWebNeed,
} from "./agent/intent.js";
import { fetchWeatherBrief } from "./tools/weather.js";
import { isInternetEnabled } from "./tools/internetAccess.js";
import { webSearch } from "./tools/websearch.js";
import { AgentLoop } from "./agent/loop.js";
import { ChatEngine } from "./chat/engine.js";
import { buildProjectContext } from "./context/packer.js";
import { projectContextCache } from "./context/projectCache.js";
import {
  downloadEmbeddingModel,
  getEmbeddingStatus,
  listEmbeddingModelsInfo,
  resetEmbedder,
  setEmbeddingRuntimeConfig,
} from "./context/embedder.js";
import { stopSharedEmbeddingServer } from "./context/embeddingServer.js";
import {
  readCodebaseIndexStatus,
  reindexProjectCodebase,
  warmProjectCodebaseIndex,
} from "./services/codebaseFacade.js";
import { listCheckpoints, restoreCheckpoint } from "./tools/checkpoints.js";
import { assertAllowedPath, resolveAgentPath } from "./tools/sandbox.js";
import { Store } from "./db/store.js";
import { v4 as uuid } from "uuid";
import { ProjectRootWatcher } from "./context/projectWatcher.js";
import { McpManager } from "./mcp/manager.js";
import {
  buildHardwareTierProfiles,
  estimateLoadPlan,
  isAutoPcProfile,
  mergeProfileIntoDefaultParams,
  suggestHardwareLoadProfile,
  tierFromProfileId,
  type LoadTier,
} from "./models/hardwareProfile.js";
import {
  annotateHfFilesWithFit,
  downloadHfFile,
  enrichHfSearchWithFit,
  listHfGgufFiles,
  recommendHfFiles,
  searchHfModels,
} from "./models/huggingface.js";
import { ensureHfCli, getHfCliStatus } from "./models/hfCli.js";
import { verifyGgufFile, withIntegrity } from "./models/integrity.js";
import { deleteLocalModelFiles } from "./models/deleteLocal.js";
import { readGgufLayerCountSync } from "./models/ggufMeta.js";
import { scanLocalModels } from "./models/scanner.js";
import { getAppDataDir, getAttachmentsDir } from "./paths.js";
import { OpenAiProxy } from "./proxy/openaiProxy.js";
import { configureRuntimeAssetFetcher } from "./runtime/assets.js";
import { RuntimeManager } from "./runtime/manager.js";
import { fetchLlamaServerMetrics } from "./runtime/serverMetrics.js";
import { SettingsStore } from "./settings.js";
import { detectSystemInfo, pickMaxVram, sampleVram } from "./system/detect.js";
import { buildModelRecommendations } from "./models/recommend.js";
import { previewWriteDiff } from "./tools/diff.js";

export type ProfileReloadStatus = ApplyLoadSettingsResult["reload"];

/** Quiet auto-update interval for llama.cpp GitHub checks. */
export const RUNTIME_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export class AppService {
  readonly appData: string;
  readonly settings: SettingsStore;
  readonly store: Store;
  readonly runtime: RuntimeManager;
  readonly chat: ChatEngine;
  readonly mcp: McpManager;
  readonly agent: AgentLoop;
  readonly proxy: OpenAiProxy;
  private modelsCache: LocalModel[] = [];
  private systemCache: SystemInfo | null = null;
  private systemCachePref: RuntimeBackend | "auto" | null = null;
  private systemDetectInflight: Promise<SystemInfo> | null = null;
  private modelDownload = { active: false, progress: 0, label: "" };
  private genStats = {
    startedAt: 0,
    tokenChars: 0,
    tokenApprox: 0,
  };
  private lastTokensPerSecond: number | null = null;
  private agentStepLabel: string | null = null;
  private errorLog: string[] = [];
  /** Serialize loadModel / unloadModel (agent runs separately). */
  private loadModelChain: Promise<void> = Promise.resolve();
  /** Serialize MCP sync so background init cannot race saveSettings. */
  private mcpSyncChain: Promise<void> = Promise.resolve();
  private agentStartLock = false;
  /** Abort in-flight startAgent waits (loadModelChain) before agent.run. */
  private agentStartAbort: AbortController | null = null;
  /** Abort weather/web/context prep before chat.send starts its own controller. */
  private chatPrepAbort: AbortController | null = null;
  private projectWatcher = new ProjectRootWatcher();

  onRuntimeProgress?: (p: { progress: number; label: string }) => void;
  onDownloadProgress?: (p: { progress: number; label: string }) => void;
  onChatToken?: (p: { sessionId: string; text: string; thinking?: boolean }) => void;
  onAgentEvent?: (p: { sessionId: string; event: import("@kovi/shared").AgentEvent }) => void;

  constructor(appData = getAppDataDir()) {
    this.appData = appData;
    this.settings = new SettingsStore(appData);
    this.store = new Store(appData);
    this.runtime = new RuntimeManager(appData);
    this.chat = new ChatEngine(this.runtime, this.store);
    this.mcp = new McpManager();
    this.agent = new AgentLoop(this.chat, this.store, this.mcp);
    this.proxy = new OpenAiProxy(this.runtime);

    this.runtime.setProgressHandler((progress, label) => {
      this.onRuntimeProgress?.({ progress, label });
    });
    this.chat.setTokenHandler((p) => {
      if (!p.thinking) {
        if (!this.genStats.startedAt) this.genStats.startedAt = Date.now();
        this.genStats.tokenChars += p.text.length;
        // Rough token estimate for fallback tok/s when server metrics missing.
        this.genStats.tokenApprox += Math.max(1, Math.round(p.text.length / 4));
      }
      this.onChatToken?.(p);
      // Unified bus: UI listens to agentEvent for both chat and agent progress.
      const event = p.draft
        ? ({ type: "model_output" as const, text: p.text })
        : p.thinking
          ? ({ type: "thinking" as const, text: p.text })
          : ({ type: "stream" as const, text: p.text });
      this.onAgentEvent?.({ sessionId: p.sessionId, event });
    });
    this.agent.setEventHandler((sessionId, event) => {
      if (event.type === "token" || event.type === "stream" || event.type === "model_output") {
        if (!this.genStats.startedAt) this.genStats.startedAt = Date.now();
        this.genStats.tokenChars += event.text.length;
        this.genStats.tokenApprox += Math.max(1, Math.round(event.text.length / 4));
      }
      if (event.type === "step_start") {
        this.agentStepLabel = event.stepId;
      }
      if (event.type === "tool_call") {
        this.agentStepLabel = event.name;
      }
      if (event.type === "plan" && event.steps.length) {
        this.agentStepLabel = `план · ${event.steps.length}`;
      }
      if (event.type === "started" && event.mode === "agent") {
        this.agentStepLabel = "агент";
      }
      if (event.type === "error") {
        this.pushErrorLog(`agent:${sessionId}`, event.message);
      }
      if (event.type === "done" || event.type === "cancelled" || event.type === "error") {
        this.agentStepLabel = null;
      }
      this.onAgentEvent?.({ sessionId, event });
    });
  }

  private emitGeneration(
    sessionId: string,
    event: import("@kovi/shared").AgentEvent,
  ): void {
    this.onAgentEvent?.({ sessionId, event });
  }

  private pushErrorLog(source: string, message: string): void {
    const line = `[${new Date().toISOString()}] ${source}: ${message}`;
    this.errorLog.push(line);
    if (this.errorLog.length > 200) this.errorLog = this.errorLog.slice(-200);
  }

  private resetGenStats(): void {
    this.genStats = { startedAt: 0, tokenChars: 0, tokenApprox: 0 };
  }

  private fallbackTokensPerSecond(): number | null {
    if (!this.genStats.startedAt || this.genStats.tokenApprox < 2) return null;
    const elapsed = (Date.now() - this.genStats.startedAt) / 1000;
    if (elapsed < 0.2) return null;
    return Math.round((this.genStats.tokenApprox / elapsed) * 10) / 10;
  }

  private shouldSkipRuntimeCheck(force?: boolean): boolean {
    if (force) return false;
    const st = this.runtime.getStatus();
    if (!st.installed) return false;
    // Local backend mismatch must not wait 24h for ensureLatest.
    if (st.update?.updateAvailable && /backend|отложен/i.test(st.update.message || "")) {
      return false;
    }
    const pref = this.settings.get().runtimeBackendPreference;
    if (pref !== "auto" && st.installed.backend !== pref) {
      return false;
    }
    const last = this.settings.get().runtimeLastCheckAt;
    if (!last) return false;
    const ts = Date.parse(last);
    if (!Number.isFinite(ts)) return false;
    return Date.now() - ts < RUNTIME_CHECK_INTERVAL_MS;
  }

  private async markRuntimeChecked(): Promise<void> {
    await this.settings.patch({
      runtimeLastCheckAt: new Date().toISOString(),
    });
  }

  /** Real secrets when settings.json holds `__secure__` (Electron safeStorage). */
  private githubTokenOverride: string | null = null;
  private hfTokenOverride: string | null = null;
  private webSearchApiKeyOverride: string | null = null;

  setGithubTokenOverride(token: string | null): void {
    this.githubTokenOverride = token && token.trim() ? token.trim() : null;
    this.applyRuntimeFetcherConfig();
  }

  setHfTokenOverride(token: string | null): void {
    this.hfTokenOverride = token && token.trim() ? token.trim() : null;
  }

  setWebSearchApiKeyOverride(key: string | null): void {
    this.webSearchApiKeyOverride = key && key.trim() ? key.trim() : null;
  }

  private resolveSecret(
    override: string | null,
    raw: string | undefined | null,
  ): string | undefined {
    if (override) return override;
    const t = raw?.trim();
    if (!t || t === "__secure__") return undefined;
    return t;
  }

  private resolveGithubToken(s = this.settings.get()): string | undefined {
    return this.resolveSecret(this.githubTokenOverride, s.githubToken);
  }

  private resolveHfToken(s = this.settings.get()): string | undefined {
    return this.resolveSecret(this.hfTokenOverride, s.hfToken);
  }

  private resolveWebSearchApiKey(s = this.settings.get()): string | undefined {
    return this.resolveSecret(this.webSearchApiKeyOverride, s.webSearchApiKey);
  }

  /** Settings with secrets hydrated for tool/runtime use. */
  getEffectiveSettings(): AppSettings {
    const s = this.settings.get();
    return {
      ...s,
      githubToken: this.resolveGithubToken(s) || "",
      hfToken: this.resolveHfToken(s) || "",
      webSearchApiKey: this.resolveWebSearchApiKey(s) || "",
    };
  }

  private applyRuntimeFetcherConfig(s = this.settings.get()): void {
    configureRuntimeAssetFetcher({
      cacheDir: path.join(this.appData, "cache"),
      githubToken: this.resolveGithubToken(s),
    });
  }

  private applyEmbeddingConfig(s = this.settings.get()): void {
    setEmbeddingRuntimeConfig({
      modelId: s.embeddingModelId || "minilm",
      appData: this.appData,
      getServerPath: () => {
        const st = this.runtime.getStatus();
        return st.installed?.serverPath ?? null;
      },
      getHfToken: () => this.resolveHfToken(),
      getDownloadMethod: () => this.settings.get().hfDownloadMethod || "auto",
      onProgress: (progress, label) => {
        this.onDownloadProgress?.({ progress, label });
      },
    });
  }

  private enqueueMcpSync(configs: McpServerConfig[]): Promise<void> {
    const next = this.mcpSyncChain.then(
      () => this.mcp.sync(configs),
      () => this.mcp.sync(configs),
    );
    this.mcpSyncChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async init(): Promise<void> {
    await this.store.ready();
    const s = this.settings.get();
    this.applyRuntimeFetcherConfig(s);
    this.applyEmbeddingConfig(s);
    // Non-blocking — hung MCP must not delay the main window.
    void this.enqueueMcpSync(s.mcpServers).catch((err) => {
      this.pushErrorLog("mcp", err instanceof Error ? err.message : String(err));
    });
    if (s.openaiProxyEnabled) {
      await this.proxy.start(s.openaiProxyPort).catch(() => undefined);
    }
    this.modelsCache = scanLocalModels(s.modelRoots, await this.getSystemInfo());

    // Auto-install / update llama.cpp to the newest GitHub release.
    if (s.autoUpdateRuntime !== false) {
      void this.ensureLatestRuntime().catch((err) => {
        console.error("Auto runtime update failed:", err);
      });
    } else {
      void this.runtime.checkUpdate(s.runtimeBackendPreference).catch(() => undefined);
    }
    this.warmCodebaseIndex();
    this.projectWatcher.start(s.projectRoot);
  }

  async dispose(): Promise<void> {
    this.projectWatcher.stop();
    this.agent.cancel();
    this.chat.stop();
    await this.agent.dispose();
    await this.enqueueMcpSync([]).catch(() => undefined);
    await this.mcp.closeAll();
    await this.proxy.stop();
    await stopSharedEmbeddingServer();
    await this.runtime.stopServer();
    this.store.close();
  }

  async addChatAttachment(sourcePath: string): Promise<ChatAttachment> {
    const src = path.resolve(String(sourcePath || "").trim());
    if (!src || !fs.existsSync(src) || !fs.statSync(src).isFile()) {
      throw new Error("Файл вложения не найден");
    }
    const stat = fs.statSync(src);
    if (stat.size > 8 * 1024 * 1024) {
      throw new Error("Вложение больше 8 МБ");
    }
    const dir = getAttachmentsDir(this.appData);
    const id = uuid();
    const base = path.basename(src).replace(/[^\w.\-()+ ]+/g, "_").slice(0, 120);
    const dest = path.join(dir, `${id}-${base}`);
    await fs.promises.copyFile(src, dest);
    const ext = path.extname(base).toLowerCase();
    const mime =
      ext === ".png"
        ? "image/png"
        : ext === ".jpg" || ext === ".jpeg"
          ? "image/jpeg"
          : ext === ".gif"
            ? "image/gif"
            : ext === ".webp"
              ? "image/webp"
              : ext === ".pdf"
                ? "application/pdf"
                : "application/octet-stream";
    return { id, name: base, mime, path: dest, size: stat.size };
  }

  /**
   * Cached system probe. Pass preference explicitly (e.g. "auto" for «Под этот ПК»)
   * so a stuck cpu/vulkan preference cannot poison hardware suggestions.
   */
  async getSystemInfo(
    preference?: RuntimeBackend | "auto",
  ): Promise<SystemInfo> {
    const pref = preference ?? this.settings.get().runtimeBackendPreference;
    if (this.systemCache && this.systemCachePref === pref) return this.systemCache;
    if (this.systemDetectInflight && this.systemCachePref === pref) {
      return this.systemDetectInflight;
    }
    this.systemCachePref = pref;
    const inflight = detectSystemInfo(pref)
      .then((info) => {
        if (this.systemCachePref === pref) this.systemCache = info;
        if (this.systemDetectInflight === inflight) this.systemDetectInflight = null;
        return info;
      })
      .catch((err) => {
        if (this.systemDetectInflight === inflight) this.systemDetectInflight = null;
        throw err;
      });
    this.systemDetectInflight = inflight;
    return inflight;
  }

  private clearSystemCache(): void {
    this.systemCache = null;
    this.systemCachePref = null;
    this.systemDetectInflight = null;
  }

  getSettings(): AppSettings {
    return this.settings.get();
  }

  async saveSettings(next: AppSettings): Promise<AppSettings> {
    const prev = this.settings.get();
    const downloadDir =
      typeof next.downloadDir === "string" && next.downloadDir.trim()
        ? next.downloadDir.trim()
        : prev.downloadDir;
    const downloadRoot = path.resolve(downloadDir);
    const modelRoots = [...next.modelRoots];
    if (
      !modelRoots.some((r) => path.resolve(r).toLowerCase() === downloadRoot.toLowerCase())
    ) {
      modelRoots.push(downloadDir);
    }
    const normalized: AppSettings = { ...next, downloadDir, modelRoots };
    const saved = await this.settings.save(normalized);
    this.applyRuntimeFetcherConfig(saved);
    this.applyEmbeddingConfig(saved);
    if (JSON.stringify(prev.mcpServers) !== JSON.stringify(saved.mcpServers)) {
      await this.enqueueMcpSync(saved.mcpServers);
    }
    if (saved.openaiProxyEnabled && !prev.openaiProxyEnabled) {
      await this.proxy.start(saved.openaiProxyPort);
    } else if (!saved.openaiProxyEnabled && prev.openaiProxyEnabled) {
      await this.proxy.stop();
    } else if (
      saved.openaiProxyEnabled &&
      saved.openaiProxyPort !== prev.openaiProxyPort
    ) {
      await this.proxy.start(saved.openaiProxyPort);
    }
    if (saved.runtimeBackendPreference !== prev.runtimeBackendPreference) {
      this.clearSystemCache();
      void this.ensureLatestRuntime(saved.runtimeBackendPreference, {
        force: true,
      }).catch((err) => {
        this.pushErrorLog(
          "runtime",
          err instanceof Error ? err.message : String(err),
        );
      });
    }
    if (saved.projectRoot !== prev.projectRoot) {
      this.projectWatcher.start(saved.projectRoot);
      if (saved.projectRoot) this.warmCodebaseIndex();
    }
    return saved;
  }

  getRuntimeStatus(): RuntimeStatus {
    return this.runtime.getStatus();
  }

  detectRuntimeAsset(backend?: RuntimeBackend | "auto"): Promise<RuntimeAsset> {
    return this.runtime.detectAsset(backend || this.settings.get().runtimeBackendPreference);
  }

  async installRuntime(backend?: RuntimeBackend | "auto"): Promise<InstalledRuntime> {
    const installed = await this.runtime.install(
      backend || this.settings.get().runtimeBackendPreference,
    );
    await this.markRuntimeChecked();
    return installed;
  }

  checkRuntimeUpdate(backend?: RuntimeBackend | "auto") {
    return this.runtime.checkUpdate(
      backend || this.settings.get().runtimeBackendPreference,
    );
  }

  async ensureLatestRuntime(
    backend?: RuntimeBackend | "auto",
    opts: { force?: boolean } = {},
  ) {
    const pref = backend || this.settings.get().runtimeBackendPreference;
    this.runtime.refreshInstalled();
    if (this.shouldSkipRuntimeCheck(opts.force)) {
      const installed = this.runtime.getStatus().installed!;
      const update = this.runtime.getStatus().update || {
        updateAvailable: false,
        currentTag: installed.tag,
        latestTag: installed.tag,
        latestAsset: null,
        checkedAt: this.settings.get().runtimeLastCheckAt || null,
        message: `Проверка отложена (не чаще раза в 24ч). Установлен ${installed.tag}.`,
      };
      return { updated: false, installed, update };
    }
    const result = await this.runtime.ensureLatest(pref, { force: opts.force });
    // Do not mark checked when update was deferred (model still loaded) — otherwise
    // 24h throttle hides backendMismatch / pending upgrade after unload.
    const deferred =
      !result.updated &&
      Boolean(result.update.updateAvailable) &&
      /отложен/i.test(result.update.message || "");
    if (result.update.latestAsset && !deferred) {
      await this.markRuntimeChecked();
    }
    return result;
  }

  listModels(): LocalModel[] {
    return this.modelsCache;
  }

  async scanModels(): Promise<LocalModel[]> {
    const sys = await this.getSystemInfo();
    this.modelsCache = scanLocalModels(this.settings.get().modelRoots, sys);
    return this.modelsCache;
  }

  async deleteModel(modelId: string): Promise<LocalModel[]> {
    const model = this.modelsCache.find((m) => m.id === modelId);
    if (!model) throw new Error("Модель не найдена");
    const roots = this.settings.get().modelRoots;
    const st = this.runtime.getStatus();
    if (st.loadedModelId === modelId) {
      if (this.chat.isBusy() || this.agent.isRunning()) {
        throw new Error("Сначала остановите генерацию или агента, затем удалите модель");
      }
      await this.unloadModel();
    }
    deleteLocalModelFiles(model, roots);
    return this.scanModels();
  }

  async getModelRecommendations(): Promise<ModelRecommendationsReport> {
    const sys = await this.getSystemInfo();
    return buildModelRecommendations(sys);
  }

  private async resolveModel(
    modelId?: string,
  ): Promise<LocalModel | undefined> {
    if (!modelId) return undefined;
    return (
      this.modelsCache.find((m) => m.id === modelId) ||
      (await this.scanModels()).find((m) => m.id === modelId)
    );
  }

  private async resolveModelSizeGb(modelId?: string): Promise<number | undefined> {
    const model = await this.resolveModel(modelId);
    return model ? model.sizeBytes / 1024 ** 3 : undefined;
  }

  private async resolveModelLayerCount(
    modelId?: string,
  ): Promise<number | null | undefined> {
    const model = await this.resolveModel(modelId);
    if (!model?.path) return undefined;
    return readGgufLayerCountSync(model.path);
  }

  async suggestHardwareLoadSettings(opts?: {
    modelId?: string;
    tier?: LoadTier;
  }): Promise<HardwareLoadSuggestion> {
    // Always probe with auto so a stuck preference cannot poison the suggestion.
    const sys = await this.getSystemInfo("auto");
    const modelSizeGb = await this.resolveModelSizeGb(opts?.modelId);
    const layerCount = await this.resolveModelLayerCount(opts?.modelId);
    return suggestHardwareLoadProfile(sys, {
      modelSizeGb,
      tier: opts?.tier,
      layerCount,
    });
  }

  async applyHardwareLoadSettings(opts?: {
    modelId?: string;
    applyBackend?: boolean;
    applyDefaultParams?: boolean;
  }): Promise<ApplyLoadSettingsResult> {
    const suggestion = await this.suggestHardwareLoadSettings({
      modelId: opts?.modelId,
      tier: "balanced",
    });
    // auto-pc profile uses balanced numbers but keeps the dedicated id/name.
    const autoProfile = {
      ...suggestion.profile,
      id: AUTO_PC_PROFILE_ID,
      name: "Под этот ПК",
      hardwareAware: true,
    };
    const sys = await this.getSystemInfo("auto");
    const modelSizeGb = await this.resolveModelSizeGb(opts?.modelId);
    const layerCount = await this.resolveModelLayerCount(opts?.modelId);
    const tiers = buildHardwareTierProfiles(sys, { modelSizeGb, layerCount });
    const cur = this.settings.get();
    const keep = (cur.loadProfiles || []).filter(
      (p) =>
        p.id !== AUTO_PC_PROFILE_ID &&
        p.id !== "fast" &&
        p.id !== "balanced" &&
        p.id !== "quality",
    );
    const applyParams = opts?.applyDefaultParams !== false;
    // Preserve user agentMaxSteps when they already set a positive budget.
    const nextAgentMaxSteps =
      cur.agentMaxSteps > 0 ? cur.agentMaxSteps : suggestion.agentMaxSteps;
    const next: AppSettings = {
      ...cur,
      loadProfiles: [...tiers, ...keep, autoProfile],
      activeLoadProfileId: AUTO_PC_PROFILE_ID,
      // Keep preference as auto so re-detect stays honest (do not stick cpu/vulkan).
      runtimeBackendPreference:
        opts?.applyBackend === false ? cur.runtimeBackendPreference : "auto",
      ...(applyParams
        ? {
            defaultParams: {
              ...cur.defaultParams,
              ...suggestion.defaultParams,
            },
            agentMaxSteps: nextAgentMaxSteps,
          }
        : {}),
    };
    if (next.runtimeBackendPreference !== cur.runtimeBackendPreference) {
      this.clearSystemCache();
    }
    const saved = await this.settings.save(next);
    const reload = await this.reloadLoadedModelAfterProfileChange();
    return { settings: saved, reload };
  }

  /** If a model is in memory, reload so -c/-ngl match the new profile. */
  private async reloadLoadedModelAfterProfileChange(): Promise<ProfileReloadStatus> {
    const loadedId = this.runtime.getStatus().loadedModelId;
    if (!loadedId) return { status: "idle" };
    if (this.chat.isBusy() || this.agent.isRunning()) {
      const detail =
        "Профиль сохранён. Остановите генерацию и перезагрузите модель, чтобы применить ngl/ctx.";
      this.pushErrorLog("loadProfile", detail);
      return { status: "skipped", detail };
    }
    try {
      await this.loadModel(loadedId);
      return { status: "ok", detail: "Модель перезагружена с новыми ngl/ctx." };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const detail = `Профиль сохранён, но перезагрузка модели не удалась: ${msg}`;
      this.pushErrorLog("loadProfile", detail);
      return { status: "error", detail };
    }
  }

  /**
   * Activate a named load profile and sync defaultParams load fields from it.
   * Tier ids (fast/balanced/quality) are refreshed from current hardware.
   */
  async applyLoadProfileToSettings(opts: {
    profileId: string;
    modelId?: string;
  }): Promise<ApplyLoadSettingsResult> {
    const cur = this.settings.get();
    const tierIds = new Set(["fast", "balanced", "quality"]);
    let profiles = [...(cur.loadProfiles || [])];
    let profile = profiles.find((p) => p.id === opts.profileId);
    let agentMaxSteps = cur.agentMaxSteps;
    let defaultParams = { ...cur.defaultParams };

    if (tierIds.has(opts.profileId) || isAutoPcProfile(opts.profileId)) {
      const tier: LoadTier =
        opts.profileId === "fast" || opts.profileId === "quality"
          ? opts.profileId
          : "balanced";
      const suggestion = await this.suggestHardwareLoadSettings({
        modelId: opts.modelId,
        tier,
      });
      if (isAutoPcProfile(opts.profileId)) {
        profile = {
          ...suggestion.profile,
          id: AUTO_PC_PROFILE_ID,
          name: "Под этот ПК",
          hardwareAware: true,
        };
      } else {
        profile = {
          ...suggestion.profile,
          id: opts.profileId,
          name:
            opts.profileId === "fast"
              ? "Быстро"
              : opts.profileId === "quality"
                ? "Качество"
                : "Баланс",
          hardwareAware: true,
        };
      }
      profiles = profiles.filter((p) => p.id !== profile!.id);
      profiles.push(profile);
      // Keep sibling tiers in sync when activating any hardware-aware tier.
      if (tierIds.has(opts.profileId)) {
        const sys = await this.getSystemInfo("auto");
        const modelSizeGb = await this.resolveModelSizeGb(opts.modelId);
        const layerCount = await this.resolveModelLayerCount(opts.modelId);
        const tiers = buildHardwareTierProfiles(sys, { modelSizeGb, layerCount });
        const keep = profiles.filter(
          (p) => p.id !== "fast" && p.id !== "balanced" && p.id !== "quality",
        );
        profiles = [...tiers, ...keep];
        profile = profiles.find((p) => p.id === opts.profileId) || profile;
      }
      defaultParams = {
        ...defaultParams,
        ...suggestion.defaultParams,
      };
      // Keep user-set positive step budget across tier switches.
      agentMaxSteps =
        cur.agentMaxSteps > 0 ? cur.agentMaxSteps : suggestion.agentMaxSteps;
    } else if (profile) {
      defaultParams = mergeProfileIntoDefaultParams(defaultParams, profile);
    } else {
      throw new Error(`Профиль загрузки не найден: ${opts.profileId}`);
    }

    // Re-read after awaits so concurrent user saves are not overwritten.
    const latest = this.settings.get();
    const saved = await this.settings.save({
      ...latest,
      loadProfiles: profiles,
      activeLoadProfileId: opts.profileId,
      defaultParams,
      agentMaxSteps:
        latest.agentMaxSteps > 0 && tierIds.has(opts.profileId)
          ? latest.agentMaxSteps
          : agentMaxSteps,
    });
    const reload = await this.reloadLoadedModelAfterProfileChange();
    return { settings: saved, reload };
  }

  getHfCliStatus() {
    return getHfCliStatus();
  }

  async ensureHfCli() {
    this.modelDownload = { active: true, progress: 0, label: "Установка HF CLI…" };
    try {
      return await ensureHfCli((progress, label) => {
        this.modelDownload = { active: true, progress, label };
        this.onDownloadProgress?.({ progress, label });
      });
    } finally {
      this.modelDownload = { active: false, progress: 100, label: "" };
    }
  }

  async searchHf(query: string): Promise<HfSearchResult[]> {
    const results = await searchHfModels(query);
    const sys = await this.getSystemInfo();
    const vram = pickMaxVram(sys);
    return enrichHfSearchWithFit(results, vram, sys.totalRamGb || 16);
  }

  async listHfFiles(modelId: string): Promise<HfFile[]> {
    const files = await listHfGgufFiles(modelId);
    const sys = await this.getSystemInfo();
    const vram = pickMaxVram(sys) ?? undefined;
    const ram = sys.totalRamGb || 16;
    const recommended = new Set(
      recommendHfFiles(files, vram, ram).map((f) => f.path),
    );
    return annotateHfFilesWithFit(files, vram, ram)
      .map((f) => ({ ...f, recommended: recommended.has(f.path) }))
      .sort((a, b) => Number(recommended.has(b.path)) - Number(recommended.has(a.path)));
  }

  async downloadHf(modelId: string, filePath: string): Promise<string> {
    this.modelDownload = { active: true, progress: 0, label: "Скачивание модели…" };
    try {
      const s = this.getEffectiveSettings();
      const method = s.hfDownloadMethod || "auto";
      this.modelDownload = {
        active: true,
        progress: 0,
        label:
          method === "http"
            ? "Скачивание (HTTP)…"
            : method === "cli"
              ? "Скачивание (HF CLI)…"
              : "Скачивание (HF CLI / HTTP)…",
      };
      this.onDownloadProgress?.({
        progress: 0,
        label: this.modelDownload.label,
      });
      const result = await downloadHfFile(modelId, filePath, s.downloadDir, {
        method,
        token: this.resolveHfToken(s),
        onProgress: (progress, label) => {
          this.modelDownload = { active: true, progress, label };
          this.onDownloadProgress?.({ progress, label });
        },
      });
      this.onDownloadProgress?.({
        progress: 100,
        label: `Готово (${result.via === "cli" ? "HF CLI" : "HTTP"})`,
      });
      // Ensure downloaded files appear in the local scan list.
      // Persist via settings.get() — never write decrypted secrets from getEffectiveSettings().
      const stored = this.settings.get();
      const downloadRoot = path.resolve(stored.downloadDir);
      if (
        !stored.modelRoots.some(
          (r) => path.resolve(r).toLowerCase() === downloadRoot.toLowerCase(),
        )
      ) {
        await this.settings.save({
          ...stored,
          modelRoots: [...stored.modelRoots, stored.downloadDir],
        });
      }
      await this.scanModels();
      return result.path;
    } finally {
      this.modelDownload = { active: false, progress: 100, label: "" };
    }
  }

  async loadModel(modelId: string, params?: Partial<GenerationParams>): Promise<void> {
    const run = async (): Promise<void> => {
      if (this.isGenerationBusy()) {
        throw new Error("Сначала остановите генерацию или агента, затем загрузите модель");
      }
      const model = this.modelsCache.find((m) => m.id === modelId);
      if (!model) throw new Error("Модель не найдена. Выполните сканирование.");
      if (model.integrityOk === false) {
        throw new Error(
          `GGUF повреждён: ${model.integrityError || model.name}. Проверьте файл или скачайте заново.`,
        );
      }
      const settings = this.settings.get();
      const profile = settings.loadProfiles.find((p) => p.id === settings.activeLoadProfileId);
      const sys = await this.getSystemInfo();
      const modelSizeGb = model.sizeBytes / 1024 ** 3;
      let loadParams: Partial<GenerationParams>;

      const layerCount = readGgufLayerCountSync(model.path);
      if (profile?.hardwareAware) {
        // Recalculate under this model — same calculator as scanner / «Под этот ПК».
        const plan = estimateLoadPlan(sys, {
          modelSizeGb,
          tier: tierFromProfileId(profile.id),
          layerCount,
        });
        loadParams = {
          gpuLayers: plan.gpuLayers,
          context: plan.context,
          flashAttn: plan.flashAttn,
          maxTokens: plan.maxTokens,
        };
        if (plan.fitsInVram === false) {
          this.pushErrorLog(
            "vram",
            `Модель ${model.name} тесно по VRAM (ngl=${plan.gpuLayers}, ctx=${plan.context}).`,
          );
        }
      } else if (profile) {
        // Manual / Advanced / CPU — respect profile as saved (no silent min with scanner).
        loadParams = {
          gpuLayers: profile.gpuLayers,
          context: profile.context,
          flashAttn: profile.flashAttn,
          maxTokens: profile.maxTokens ?? settings.defaultParams.maxTokens,
        };
      } else {
        const plan = estimateLoadPlan(sys, {
          modelSizeGb,
          tier: "balanced",
          layerCount,
        });
        loadParams = {
          gpuLayers: plan.gpuLayers,
          context: plan.context,
          flashAttn: plan.flashAttn,
          maxTokens: plan.maxTokens,
        };
      }

      const merged: GenerationParams = {
        ...DEFAULT_GENERATION_PARAMS,
        ...settings.defaultParams,
        ...loadParams,
        ...params,
      };
      if (model.fitsInVram === false && merged.gpuLayers > 0) {
        this.pushErrorLog(
          "vram",
          `Модель ${model.name} может не влезть в VRAM (ngl=${merged.gpuLayers}, ctx=${merged.context}).`,
        );
      }
      const installed = await this.runtime.ensureInstalled(
        settings.runtimeBackendPreference,
      );
      // Plan ngl/flashAttn against the *installed* backend, not only recommended.
      if (installed.backend && installed.backend !== sys.recommendedBackend) {
        const planForInstalled = estimateLoadPlan(
          { ...sys, recommendedBackend: installed.backend },
          {
            modelSizeGb,
            tier: profile?.hardwareAware
              ? tierFromProfileId(profile.id)
              : "balanced",
            layerCount,
          },
        );
        if (profile?.hardwareAware || !profile) {
          merged.gpuLayers = planForInstalled.gpuLayers;
          merged.context = planForInstalled.context;
          merged.flashAttn = planForInstalled.flashAttn;
          merged.maxTokens = planForInstalled.maxTokens;
        } else if (installed.backend === "cpu") {
          merged.gpuLayers = 0;
          merged.flashAttn = false;
        }
        this.pushErrorLog(
          "runtime",
          `Установлен backend ${installed.backend} (рекомендован ${sys.recommendedBackend}) — параметры нагрузки подогнаны.`,
        );
      }
      this.resetGenStats();
      try {
        await this.runtime.loadModel(model, merged);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.pushErrorLog("loadModel", msg);
        throw err;
      }
      if (settings.autoUpdateRuntime !== false) {
        void this.ensureLatestRuntime(settings.runtimeBackendPreference).catch((err) => {
          console.error("Background runtime update failed:", err);
        });
      }
    };
    const next = this.loadModelChain.then(run, run);
    this.loadModelChain = next.then(
      () => undefined,
      () => undefined,
    );
    await next;
  }

  async unloadModel(): Promise<void> {
    const run = async () => {
      if (this.isGenerationBusy()) {
        throw new Error("Сначала остановите генерацию или агента");
      }
      await this.runtime.stopServer();
    };
    const next = this.loadModelChain.then(run, run);
    this.loadModelChain = next.then(
      () => undefined,
      () => undefined,
    );
    await next;
  }

  listSessions(): ChatSession[] {
    return this.store.listSessions();
  }

  createSession(mode?: "chat" | "agent", title?: string): ChatSession {
    const settings = this.settings.get();
    // Cursor-like: with a project folder, new chats are Agent mode by default.
    const resolved: "chat" | "agent" =
      mode ??
      (settings.projectRoot && String(settings.projectRoot).trim() ? "agent" : "chat");
    return this.store.createSession(resolved, title, settings.defaultParams);
  }

  updateSession(patch: SessionPatch | (Partial<ChatSession> & { id: string })): ChatSession {
    // Whitelist merge — UI snapshot must never wipe agentScratchpad / identity.
    const existing = this.store.listSessions().find((s) => s.id === patch.id);
    if (!existing) throw new Error("Сессия не найдена");
    const toolsEnabled =
      patch.toolsEnabled !== undefined ? patch.toolsEnabled : existing.toolsEnabled;
    // Keep stock system prompt in sync when toggling Агент/Чат from UI.
    let systemPrompt = patch.systemPrompt ?? existing.systemPrompt;
    if (
      patch.toolsEnabled !== undefined &&
      patch.toolsEnabled !== existing.toolsEnabled &&
      patch.systemPrompt === undefined
    ) {
      const synced = this.store.setToolsEnabled(existing.id, patch.toolsEnabled);
      if (synced) return synced;
    }
    return this.store.updateSession({
      ...existing,
      title: patch.title ?? existing.title,
      mode: patch.mode ?? existing.mode,
      toolsEnabled,
      systemPrompt,
      modelId: patch.modelId !== undefined ? patch.modelId : existing.modelId,
      pinned: patch.pinned !== undefined ? patch.pinned : existing.pinned,
      folder:
        patch.folder !== undefined
          ? patch.folder.trim() || undefined
          : existing.folder,
      params: patch.params
        ? { ...existing.params, ...patch.params }
        : existing.params,
      id: existing.id,
      createdAt: existing.createdAt,
      agentScratchpad: existing.agentScratchpad,
    });
  }

  setSessionToolsEnabled(sessionId: string, enabled: boolean): ChatSession {
    const updated = this.store.setToolsEnabled(sessionId, enabled);
    if (!updated) throw new Error("Сессия не найдена");
    return updated;
  }

  deleteSession(sessionId: string): void {
    this.agent.clearSessionAllow(sessionId);
    this.store.deleteSession(sessionId);
  }

  getMessages(sessionId: string): ChatMessage[] {
    return this.store.getMessages(sessionId);
  }

  private maybeRenameSession(session: ChatSession, content: string): void {
    if (/^Новый\b/i.test(session.title)) {
      session.title = content.slice(0, 48).trim() || session.title;
      this.store.updateSession(session);
    }
  }

  /**
   * Decide chat vs agent: @agent prefix, coding/tool intent, preferAgent flag, or project actions.
   * Empty payload after @agent throws via sendMessage (returns useAgent + empty content marker).
   */
  static parseAgentIntent(
    content: string,
    preferAgent: boolean,
    opts?: { projectRoot?: string | null },
  ): { content: string; useAgent: boolean; emptyAgentPrefix?: boolean } {
    const trimmed = content.trim();
    const prefix = trimmed.match(/^(@agent|\/agent)\b[\s:]*/i);
    if (prefix) {
      const rest = trimmed.slice(prefix[0].length).trim();
      if (!rest) {
        return { content: "", useAgent: true, emptyAgentPrefix: true };
      }
      return { content: rest, useAgent: true };
    }
    // Explicit chat mode (preferAgent=false): never auto-route to agent.
    if (!preferAgent) {
      return { content: trimmed, useAgent: false };
    }
    // Live weather/news → plain chat, but not coding tasks that merely mention «погода».
    if (
      detectLiveWebNeed(trimmed) &&
      !detectAgentTask(trimmed, opts)
    ) {
      return { content: trimmed, useAgent: false };
    }
    return {
      content: trimmed,
      useAgent: preferAgent || detectAgentTask(trimmed, opts),
    };
  }

  async sendChat(
    sessionId: string,
    content: string,
    params?: Partial<GenerationParams>,
    attachments?: ChatAttachment[],
  ): Promise<ChatMessage> {
    if (this.isGenerationBusy()) {
      throw new Error("Генерация уже выполняется. Дождитесь ответа или нажмите Стоп.");
    }
    const session = this.store.listSessions().find((s) => s.id === sessionId);
    if (!session) throw new Error("Сессия не найдена");
    this.chatPrepAbort?.abort();
    this.chatPrepAbort = new AbortController();
    const prepSignal = this.chatPrepAbort.signal;
    this.noteGenerationStart();
    this.emitGeneration(sessionId, { type: "started", mode: "chat" });
    const loadedCtx = this.runtime.getStatus().loadedContext;
    const merged = {
      ...session.params,
      ...(typeof loadedCtx === "number" && loadedCtx > 0
        ? { context: loadedCtx }
        : {}),
      ...params,
    };
    // Hydrate safeStorage secrets (Tavily etc.) — raw get() may hold "__secure__".
    const settings = this.getEffectiveSettings();
    let system = session.systemPrompt;
    const cancelledResult = (): ChatMessage => ({
      id: `cancelled-${Date.now()}`,
      role: "assistant",
      content: "(отменено)",
      createdAt: new Date().toISOString(),
    });
    try {
      // Lightweight Cursor-style project context for plain chat (no tool catalog).
      if (settings.projectRoot) {
        if (prepSignal.aborted) {
          this.emitGeneration(sessionId, { type: "cancelled" });
          return cancelledResult();
        }
        try {
          const packed = await buildProjectContext({
            settings,
            userQuery: content,
            baseSystem: session.systemPrompt,
            toolBlock:
              "Инструменты недоступны в этом ответе. Для правок файлов начните с @agent или опишите задачу по коду.",
            contextTokens: merged.context || 8192,
            // Leave generous room for a long reply (aligned with completionBudget).
            reserveTokens: Math.min(Math.floor((merged.context || 8192) * 0.55), 10000),
          });
          if (!prepSignal.aborted) system = packed.systemPrompt;
        } catch {
          // fall back to bare system prompt
        }
      }
      if (prepSignal.aborted) {
        this.emitGeneration(sessionId, { type: "cancelled" });
        return cancelledResult();
      }
      // Live facts (weather/news/rates): inject web search — plain chat has no tools.
      // Gated by internetAccessMode (off = no network; ask/allow = user allowed internet).
      if (detectLiveWebNeed(content)) {
        if (!isInternetEnabled(settings)) {
          system =
            `${system}\n\n## Интернет\n` +
            `Доступ в сеть выключен в Настройках → Веб-поиск. ` +
            `Честно скажи, что актуальную погоду/новости/курсы узнать нельзя, пока пользователь не включит «Спрашивать» или «Разрешить». Не выдумывай цифры.`;
        } else {
          const now = new Date();
          const dateLabel = now.toLocaleString("ru-RU", {
            timeZone: "Europe/Moscow",
            dateStyle: "full",
            timeStyle: "short",
          });
          this.emitGeneration(sessionId, {
            type: "thinking",
            text: "Ищу актуальные данные в интернете…",
          });
          const wantsWeather =
            /(погод\p{L}*|weather|forecast|прогноз\p{L}*|температур\p{L}*)/iu.test(content);
          try {
            let injected = "";
            if (wantsWeather && !prepSignal.aborted) {
              try {
                const brief = await fetchWeatherBrief(content);
                if (brief && !prepSignal.aborted) {
                  injected =
                    `## Погода (${dateLabel})\n` +
                    `Официальные данные ниже. Ответь коротко и по делу на языке пользователя.\n\n${brief.summary}`;
                }
              } catch {
                /* fall through to web search */
              }
            }
            if (!injected && !prepSignal.aborted) {
              const hits = await webSearch(content, settings);
              if (!hits || hits === "Ничего не найдено" || hits === "Пустой запрос") {
                injected =
                  `## Веб-поиск (${dateLabel})\n` +
                  `По запросу ничего не найдено (провайдер: ${settings.webSearchProvider || "duckduckgo"}). ` +
                  `Честно скажи, что актуальных данных нет. Не выдумывай погоду/курсы/новости.`;
              } else {
                injected =
                  `## Веб-поиск (${dateLabel})\n` +
                  `Свежие сниппеты. Опирайся на них; не выдумывай цифры.\n\n${hits.slice(0, 6000)}`;
              }
            }
            if (injected && !prepSignal.aborted) system = `${system}\n\n${injected}`;
          } catch (err) {
            if (!prepSignal.aborted) {
              const msg = err instanceof Error ? err.message : String(err);
              system =
                `${system}\n\n## Веб-поиск\n` +
                `Поиск не удался: ${msg}. Скажи, что без интернета актуальную погоду/новости узнать нельзя. Не выдумывай.`;
            }
          }
        }
      }
      if (prepSignal.aborted) {
        this.emitGeneration(sessionId, { type: "cancelled" });
        return cancelledResult();
      }
      // Keep prep abort until send() installs its own controller (no busy gap).
      const result = await this.chat.send(
        sessionId,
        content,
        merged,
        system,
        attachments,
      );
      if (this.chatPrepAbort?.signal === prepSignal) {
        this.chatPrepAbort = null;
      }
      this.maybeRenameSession(session, content);
      this.emitGeneration(sessionId, { type: "done", messageId: result.id });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (prepSignal.aborted || /отмен|abort/i.test(message)) {
        this.emitGeneration(sessionId, { type: "cancelled" });
        // Do not rethrow — avoids duplicate IPC error after cancel (P0-6).
        return cancelledResult();
      }
      this.pushErrorLog(`chat:${sessionId}`, message);
      this.emitGeneration(sessionId, { type: "error", message });
      // Do not rethrow — IPC sendMessage.catch would duplicate the error event.
      return {
        id: `error-${Date.now()}`,
        role: "assistant",
        content: `(ошибка) ${message}`,
        createdAt: new Date().toISOString(),
      };
    } finally {
      if (this.chatPrepAbort?.signal === prepSignal) {
        this.chatPrepAbort = null;
      }
    }
  }

  /** True while chat prep (weather/web/context), chat stream, or agent is active. */
  isGenerationBusy(): boolean {
    return (
      Boolean(this.chatPrepAbort) ||
      this.chat.isBusy() ||
      this.agent.isRunning() ||
      this.agentStartLock ||
      Boolean(this.agentStartAbort)
    );
  }

  /**
   * Unified send: progress always via onAgentEvent (started → … → done/error/cancelled).
   * Fire-and-forget from IPC — resolves without a ChatMessage when agent path is used.
   */
  /** Build text block from attachments (text files inlined, others as path meta). */
  static formatAttachmentsBlock(attachments: ChatAttachment[]): string {
    if (!attachments.length) return "";
    const parts: string[] = ["\n\n[Вложения]"];
    let budget = 32_000;
    for (const a of attachments) {
      const isText =
        /^text\//i.test(a.mime) ||
        /\.(txt|md|json|ts|tsx|js|jsx|py|rs|go|java|c|cpp|h|css|html|yml|yaml|toml|xml|csv|log)$/i.test(
          a.name,
        );
      if (isText && fs.existsSync(a.path) && budget > 0) {
        try {
          const raw = fs.readFileSync(a.path, "utf8");
          const slice = raw.slice(0, Math.min(budget, 16_000));
          budget -= slice.length;
          parts.push(`--- ${a.name} ---\n${slice}`);
          continue;
        } catch {
          /* fall through */
        }
      }
      if (/^image\//i.test(a.mime)) {
        parts.push(
          `- ${a.name} (${a.mime}, ${a.size} B) — изображение приложено как файл; ` +
            `текстовая модель его не видит (нужен vision/mmproj). path=${a.path}`,
        );
      } else {
        parts.push(`- ${a.name} (${a.mime}, ${a.size} B) path=${a.path}`);
      }
    }
    return parts.join("\n");
  }

  async sendMessage(
    sessionId: string,
    content: string,
    opts?: {
      useAgent?: boolean;
      params?: Partial<GenerationParams>;
      attachments?: ChatAttachment[];
    },
  ): Promise<void> {
    const settings = this.settings.get();
    const session = this.store.listSessions().find((s) => s.id === sessionId);
    const preferAgent =
      opts?.useAgent ?? (session ? sessionToolsEnabled(session) : false);
    // Intent from user text only — attachment bodies must not flip chat→agent / coding.
    const parsed = AppService.parseAgentIntent(content, preferAgent, {
      projectRoot: settings.projectRoot,
    });
    if (parsed.emptyAgentPrefix) {
      throw new Error("После @agent укажите задачу (например: @agent list files)");
    }
    if (!parsed.content) throw new Error("Пустое сообщение");
    const attBlock = opts?.attachments?.length
      ? AppService.formatAttachmentsBlock(opts.attachments)
      : "";
    const contentForModel = parsed.content + attBlock;
    if (parsed.useAgent) {
      await this.startAgent(sessionId, contentForModel, opts?.attachments);
      return;
    }
    await this.sendChat(
      sessionId,
      contentForModel,
      opts?.params,
      opts?.attachments,
    );
  }

  stopGeneration(): void {
    this.chatPrepAbort?.abort();
    this.chatPrepAbort = null;
    this.agentStartAbort?.abort();
    this.chat.stop();
    this.agent.cancel();
  }

  /** Approx local tok/s while streaming when server metrics are unavailable. */
  noteGenerationStart(): void {
    this.resetGenStats();
    this.genStats.startedAt = Date.now();
  }

  async startAgent(
    sessionId: string,
    content: string,
    attachments?: ChatAttachment[],
  ): Promise<void> {
    if (this.agent.isRunning() || this.agentStartLock) {
      // Non-terminal for the live run — callers must not treat as agentEvent error.
      const err = new Error("Агент уже выполняется");
      (err as Error & { code?: string }).code = "AGENT_BUSY";
      throw err;
    }
    // Abort chat weather/web prep so agent and chat don't share ChatEngine.abort.
    this.chatPrepAbort?.abort();
    this.chatPrepAbort = null;
    if (this.chat.isBusy()) {
      this.chat.stop();
    }
    // Sync lock before any await — prevents double-start race.
    this.agentStartLock = true;
    const startAbort = new AbortController();
    this.agentStartAbort = startAbort;
    try {
      // Wait for in-flight load/unload without joining the chain as a follower.
      await this.loadModelChain.catch(() => undefined);
      if (startAbort.signal.aborted) {
        this.emitGeneration(sessionId, { type: "cancelled" });
        return;
      }
      await this.startAgentInner(sessionId, content, attachments);
    } finally {
      if (this.agentStartAbort === startAbort) this.agentStartAbort = null;
      this.agentStartLock = false;
    }
  }

  private async startAgentInner(
    sessionId: string,
    content: string,
    attachments?: ChatAttachment[],
  ): Promise<void> {
    if (this.chat.isBusy()) {
      this.chat.stop();
    }
    const session = this.store.listSessions().find((s) => s.id === sessionId);
    if (!session) throw new Error("Сессия не найдена");
    const settings = this.getEffectiveSettings();
    if (settings.fileAccessMode === "project") {
      if (!settings.projectRoot) {
        throw new Error(
          "Режим project: выберите папку проекта в Настройках перед запуском агента",
        );
      }
      try {
        const st = fs.statSync(settings.projectRoot);
        if (!st.isDirectory()) {
          throw new Error(`Папка проекта не является каталогом: ${settings.projectRoot}`);
        }
      } catch (err) {
        if (err instanceof Error && /Настройках|каталогом/.test(err.message)) throw err;
        throw new Error(`Папка проекта недоступна: ${settings.projectRoot}`);
      }
    } else if (!settings.projectRoot) {
      this.pushErrorLog(
        "agent",
        "Папка проекта не задана — shell/относительные пути могут не работать. Укажите projectRoot в Настройках.",
      );
    }
    await this.runtime.assertLlmReady();
    this.emitGeneration(sessionId, { type: "started", mode: "agent" });
    this.noteGenerationStart();
    this.maybeRenameSession(session, content);
    const loadedCtx = this.runtime.getStatus().loadedContext;
    const agentParams = {
      ...session.params,
      ...(typeof loadedCtx === "number" && loadedCtx > 0
        ? { context: loadedCtx }
        : {}),
    };
    await this.agent.run(
      sessionId,
      content,
      settings,
      agentParams,
      session.systemPrompt,
      attachments,
    );
  }

  resolveConfirmation(
    confirmationId: string,
    approved: boolean,
    rememberForSession?: boolean,
  ): boolean {
    return this.agent.resolveConfirmation(
      confirmationId,
      approved,
      rememberForSession,
    );
  }

  cancelAgent(): void {
    // Same as Stop: abort chat stream and agent loop.
    this.stopGeneration();
  }

  async getStatusBar(): Promise<Omit<StatusBarInfo, "view">> {
    const snap = await this.getMonitorSnapshot();
    return {
      modelName: snap.modelName,
      loadedModelId: snap.loadedModelId,
      backend: snap.backend,
      serverPort: snap.serverPort,
      vramUsedGb: snap.vramUsedGb,
      vramTotalGb: snap.vramTotalGb,
      ramUsedGb: snap.ramUsedGb,
      ramTotalGb: snap.ramTotalGb,
      tokensPerSecond: snap.tokensPerSecond,
      agentStepLabel: this.agentStepLabel,
      busy: snap.busy,
      lastError: snap.lastError,
    };
  }

  exportSession(sessionId: string): SessionExportBundle {
    return this.store.exportSession(sessionId);
  }

  exportSessionFolder(folder: string): SessionExportBundle[] {
    return this.store.exportSessionFolder(folder);
  }

  importSession(bundle: SessionExportBundle): ChatSession {
    return this.store.importSession(bundle);
  }

  listCheckpoints(): Array<{
    runId: string;
    relPath: string;
    checkpointPath: string;
    mtimeMs: number;
  }> {
    const root = this.settings.get().projectRoot;
    if (!root) return [];
    return listCheckpoints(root);
  }

  async restoreCheckpoint(checkpointPath: string): Promise<string> {
    const settings = this.settings.get();
    if (!settings.projectRoot) throw new Error("Нужна папка проекта");
    return restoreCheckpoint({
      projectRoot: settings.projectRoot,
      checkpointAbsOrRel: checkpointPath,
      settings,
    });
  }

  resolveOpenPath(targetPath: string): string {
    const settings = this.settings.get();
    const resolved = resolveAgentPath(targetPath, settings.projectRoot);
    return assertAllowedPath(
      resolved,
      settings.fileAccessMode,
      settings.projectRoot,
      settings.modelRoots,
    );
  }

  getErrorLog(): string {
    const runtimeErr = this.runtime.getStatus().lastError;
    const lines = [...this.errorLog];
    if (runtimeErr) lines.push(`[runtime] ${runtimeErr}`);
    return lines.join("\n") || "Лог пуст — ошибок пока не было.";
  }

  async checkMcpHealth(server?: McpServerConfig): Promise<McpHealthResult[]> {
    const list = server ? [server] : this.settings.get().mcpServers;
    return this.mcp.healthCheck(list);
  }

  async verifyGguf(modelId: string): Promise<LocalModel> {
    const model = this.modelsCache.find((m) => m.id === modelId);
    if (!model) throw new Error("Модель не найдена");
    const v = await verifyGgufFile(model.path);
    const next = withIntegrity({
      ...model,
      integrityOk: v.ok,
      integrityError: v.error,
    });
    this.modelsCache = this.modelsCache.map((m) => (m.id === modelId ? next : m));
    if (!v.ok) this.pushErrorLog("gguf", `${model.name}: ${v.error}`);
    return next;
  }

  previewFileDiff(filePath: string, content: string): string {
    return previewWriteDiff(filePath, content, this.getSettings());
  }

  getCodebaseIndexStatus(): CodebaseIndexStatus {
    return readCodebaseIndexStatus(this.settings.get().projectRoot);
  }

  listProjectMentions(): { root: string | null; files: string[] } {
    const root = this.settings.get().projectRoot;
    if (!root) return { root: null, files: [] };
    try {
      const map = projectContextCache.getMap(root, { maxEntries: 500, maxDepth: 8 });
      return { root, files: map.files };
    } catch {
      return { root, files: [] };
    }
  }

  listEmbeddingModels(): EmbeddingModelInfo[] {
    this.applyEmbeddingConfig();
    return listEmbeddingModelsInfo();
  }

  getEmbeddingStatus(): EmbeddingStatus {
    this.applyEmbeddingConfig();
    return getEmbeddingStatus();
  }

  async downloadEmbeddingModel(id: EmbeddingModelId): Promise<EmbeddingModelInfo> {
    this.applyEmbeddingConfig();
    return downloadEmbeddingModel(id);
  }

  async setEmbeddingModel(id: EmbeddingModelId): Promise<{
    settings: AppSettings;
    status: EmbeddingStatus;
    index: CodebaseIndexStatus;
  }> {
    if (id !== "minilm" && id !== "lfm25") {
      throw new Error(`Unknown embedding model: ${id}`);
    }
    this.applyEmbeddingConfig();
    let models = listEmbeddingModelsInfo();
    let info = models.find((m) => m.id === id);
    if (!info?.installed) {
      await downloadEmbeddingModel(id);
      models = listEmbeddingModelsInfo();
      info = models.find((m) => m.id === id);
    }
    if (!info?.installed) {
      throw new Error(
        `Модель эмбеддингов «${id}» не установилась. Скачайте ещё раз или проверьте сеть.`,
      );
    }
    if (id === "lfm25" && !info.ready) {
      throw new Error(
        info.error ||
          "LFM2.5 нужен установленный llama-server (Runtime). Установите runtime и повторите.",
      );
    }
    const prev = this.settings.get();
    const prevEmbedId = prev.embeddingModelId || "minilm";
    const next = await this.settings.save({ ...prev, embeddingModelId: id });
    this.applyEmbeddingConfig(next);
    await resetEmbedder();
    this.applyEmbeddingConfig(next);
    const projectRoot = this.settings.get().projectRoot;
    if (!projectRoot || !String(projectRoot).trim()) {
      // Model applied; index will build when project folder is set.
      return {
        settings: this.settings.get(),
        status: getEmbeddingStatus(),
        index: {
          ready: false,
          indexing: false,
          root: null,
          chunkCount: 0,
          modelId: id,
          updatedAt: null,
          error: null,
        },
      };
    }
    const index = await this.reindexCodebase();
    if (index.error) {
      // Roll back so @codebase doesn't query with a new dim against an old index.
      await this.settings.save({
        ...this.settings.get(),
        embeddingModelId: prevEmbedId,
      });
      this.applyEmbeddingConfig();
      await resetEmbedder();
      this.applyEmbeddingConfig();
      throw new Error(`Индекс не пересобран: ${index.error}. Модель эмбеддингов не применена.`);
    }
    return {
      settings: this.settings.get(),
      status: getEmbeddingStatus(),
      index,
    };
  }

  async reindexCodebase(): Promise<CodebaseIndexStatus> {
    return reindexProjectCodebase(this.settings.get().projectRoot, (p) =>
      this.onDownloadProgress?.(p),
    );
  }

  /** Warm semantic index in background after project root is set. */
  warmCodebaseIndex(): void {
    warmProjectCodebaseIndex(this.settings.get().projectRoot);
  }

  async getMonitorSnapshot(): Promise<MonitorSnapshot> {
    const st = this.runtime.getStatus();
    const model = this.modelsCache.find((m) => m.id === st.loadedModelId);
    const vram = await sampleVram();
    const total = os.totalmem() / 1024 ** 3;
    const free = os.freemem() / 1024 ** 3;
    const busy = this.isGenerationBusy();

    let tokensPerSecond: number | null = null;
    let promptTokensPerSecond: number | null = null;
    let contextUsed: number | null = null;
    let contextSize: number | null = model?.recommendedContext ?? null;
    let metricsSource = "none";

    if (st.serverPort) {
      const m = await fetchLlamaServerMetrics(st.serverPort);
      tokensPerSecond = m.tokensPerSecond;
      promptTokensPerSecond = m.promptTokensPerSecond;
      contextUsed = m.contextUsed;
      if (m.contextSize != null) contextSize = m.contextSize;
      metricsSource = m.source;
    }

    const metricsUseless =
      tokensPerSecond == null || (tokensPerSecond === 0 && busy);
    if (metricsUseless && busy) {
      tokensPerSecond = this.fallbackTokensPerSecond();
      if (tokensPerSecond != null) metricsSource = "stream";
    }
    if (tokensPerSecond != null && tokensPerSecond > 0) {
      this.lastTokensPerSecond = tokensPerSecond;
    } else if (!busy && this.lastTokensPerSecond != null) {
      tokensPerSecond = this.lastTokensPerSecond;
      if (metricsSource === "none") metricsSource = "last";
    }

    const settings = this.settings.get();
    return {
      modelName: model?.name || st.loadedModelName || null,
      loadedModelId: st.loadedModelId,
      backend: st.installed?.backend || null,
      runtimeTag: st.installed?.tag || null,
      serverPort: st.serverPort,
      serverRunning: st.serverRunning,
      busy,
      vramUsedGb: vram.usedGb,
      vramTotalGb: vram.totalGb,
      gpuUtilPercent: vram.gpuUtilPercent,
      ramUsedGb: Math.round((total - free) * 10) / 10,
      ramTotalGb: Math.round(total * 10) / 10,
      runtimeDownloading: st.downloading,
      runtimeProgress: st.downloadProgress,
      runtimeLabel: st.downloadLabel,
      modelDownloading: this.modelDownload.active,
      modelProgress: this.modelDownload.progress,
      modelLabel: this.modelDownload.label,
      tokensPerSecond,
      promptTokensPerSecond,
      contextUsed,
      contextSize,
      metricsSource,
      lastError: st.lastError,
      runtimeLastCheckAt: settings.runtimeLastCheckAt || null,
      updateAvailable: Boolean(st.update?.updateAvailable),
      latestTag: st.update?.latestTag || null,
      checkedAt: new Date().toISOString(),
    };
  }
}

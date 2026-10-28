import os from "node:os";
import path from "node:path";
import type {
  AppSettings,
  ChatMessage,
  ChatSession,
  GenerationParams,
  HfFile,
  HfSearchResult,
  InstalledRuntime,
  LocalModel,
  McpHealthResult,
  McpServerConfig,
  MonitorSnapshot,
  RuntimeAsset,
  RuntimeBackend,
  RuntimeStatus,
  SessionExportBundle,
  StatusBarInfo,
  SystemInfo,
} from "@kovi/shared";
import { DEFAULT_GENERATION_PARAMS } from "@kovi/shared";
import { AgentLoop } from "./agent/loop.js";
import { ChatEngine } from "./chat/engine.js";
import { Store } from "./db/store.js";
import { McpManager } from "./mcp/manager.js";
import {
  downloadHfFile,
  listHfGgufFiles,
  recommendHfFiles,
  searchHfModels,
} from "./models/huggingface.js";
import { verifyGgufFile, withIntegrity } from "./models/integrity.js";
import { scanLocalModels } from "./models/scanner.js";
import { getAppDataDir } from "./paths.js";
import { OpenAiProxy } from "./proxy/openaiProxy.js";
import { configureRuntimeAssetFetcher } from "./runtime/assets.js";
import { RuntimeManager } from "./runtime/manager.js";
import { fetchLlamaServerMetrics } from "./runtime/serverMetrics.js";
import { SettingsStore } from "./settings.js";
import { detectSystemInfo, sampleVram } from "./system/detect.js";
import { previewWriteDiff } from "./tools/diff.js";

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
  private modelDownload = { active: false, progress: 0, label: "" };
  private genStats = {
    startedAt: 0,
    tokenChars: 0,
    tokenApprox: 0,
  };
  private lastTokensPerSecond: number | null = null;
  private agentStepLabel: string | null = null;
  private errorLog: string[] = [];

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
    });
    this.agent.setEventHandler((sessionId, event) => {
      if (event.type === "token") {
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
      if (event.type === "error") {
        this.pushErrorLog(`agent:${sessionId}`, event.message);
      }
      if (event.type === "done" || event.type === "cancelled" || event.type === "error") {
        this.agentStepLabel = null;
      }
      this.onAgentEvent?.({ sessionId, event });
    });
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
    if (!this.runtime.getStatus().installed) return false;
    const last = this.settings.get().runtimeLastCheckAt;
    if (!last) return false;
    const ts = Date.parse(last);
    if (!Number.isFinite(ts)) return false;
    return Date.now() - ts < RUNTIME_CHECK_INTERVAL_MS;
  }

  private async markRuntimeChecked(): Promise<void> {
    const s = this.settings.get();
    await this.settings.save({
      ...s,
      runtimeLastCheckAt: new Date().toISOString(),
    });
  }

  private applyRuntimeFetcherConfig(s = this.settings.get()): void {
    configureRuntimeAssetFetcher({
      cacheDir: path.join(this.appData, "cache"),
      githubToken: s.githubToken?.trim() || undefined,
    });
  }

  async init(): Promise<void> {
    const s = this.settings.get();
    this.applyRuntimeFetcherConfig(s);
    await this.mcp.sync(s.mcpServers);
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
  }

  async dispose(): Promise<void> {
    await this.agent.dispose();
    await this.mcp.closeAll();
    await this.proxy.stop();
    await this.runtime.stopServer();
    this.store.close();
  }

  async getSystemInfo(): Promise<SystemInfo> {
    if (this.systemCache) return this.systemCache;
    const pref = this.settings.get().runtimeBackendPreference;
    this.systemCache = await detectSystemInfo(pref);
    return this.systemCache;
  }

  getSettings(): AppSettings {
    return this.settings.get();
  }

  async saveSettings(next: AppSettings): Promise<AppSettings> {
    const prev = this.settings.get();
    const saved = await this.settings.save(next);
    this.applyRuntimeFetcherConfig(saved);
    if (JSON.stringify(prev.mcpServers) !== JSON.stringify(saved.mcpServers)) {
      await this.mcp.sync(saved.mcpServers);
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
    this.systemCache = null;
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
    // Only throttle after GitHub actually resolved an asset (not on rate-limit/network fail).
    if (result.update.latestAsset) {
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

  searchHf(query: string): Promise<HfSearchResult[]> {
    return searchHfModels(query);
  }

  async listHfFiles(modelId: string): Promise<HfFile[]> {
    const files = await listHfGgufFiles(modelId);
    const sys = await this.getSystemInfo();
    const vram = sys.gpus.find((g) => g.vramGb)?.vramGb;
    const recommended = new Set(
      recommendHfFiles(files, vram, sys.totalRamGb).map((f) => f.path),
    );
    return files
      .map((f) => ({ ...f, recommended: recommended.has(f.path) }))
      .sort((a, b) => Number(recommended.has(b.path)) - Number(recommended.has(a.path)));
  }

  async downloadHf(modelId: string, filePath: string): Promise<string> {
    this.modelDownload = { active: true, progress: 0, label: "Скачивание модели…" };
    try {
      const dest = await downloadHfFile(
        modelId,
        filePath,
        this.settings.get().downloadDir,
        (progress, label) => {
          this.modelDownload = { active: true, progress, label };
          this.onDownloadProgress?.({ progress, label });
        },
      );
      await this.scanModels();
      return dest;
    } finally {
      this.modelDownload = { active: false, progress: 100, label: "" };
    }
  }

  async loadModel(modelId: string, params?: Partial<GenerationParams>): Promise<void> {
    const model = this.modelsCache.find((m) => m.id === modelId);
    if (!model) throw new Error("Модель не найдена. Выполните сканирование.");
    if (model.integrityOk === false) {
      throw new Error(
        `GGUF повреждён: ${model.integrityError || model.name}. Проверьте файл или скачайте заново.`,
      );
    }
    const settings = this.settings.get();
    const profile = settings.loadProfiles.find((p) => p.id === settings.activeLoadProfileId);
    const profileParams: Partial<GenerationParams> = profile
      ? {
          gpuLayers: profile.gpuLayers,
          context: profile.context,
          flashAttn: profile.flashAttn,
          maxTokens: profile.maxTokens ?? settings.defaultParams.maxTokens,
        }
      : {};
    const merged: GenerationParams = {
      ...DEFAULT_GENERATION_PARAMS,
      ...settings.defaultParams,
      gpuLayers: model.recommendedNgl,
      context: model.recommendedContext,
      ...profileParams,
      ...params,
    };
    if (model.fitsInVram === false && merged.gpuLayers > 32) {
      this.pushErrorLog(
        "vram",
        `Модель ${model.name} может не влезть в VRAM (ngl=${merged.gpuLayers}, ctx=${merged.context}).`,
      );
    }
    // Do not block model load on GitHub updates — only ensure a local binary exists.
    await this.runtime.ensureInstalled(settings.runtimeBackendPreference);
    this.resetGenStats();
    try {
      await this.runtime.loadModel(model, merged);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.pushErrorLog("loadModel", msg);
      throw err;
    }
    // Quiet update only AFTER model is up — ensureLatest defers while server is running.
    if (settings.autoUpdateRuntime !== false) {
      void this.ensureLatestRuntime(settings.runtimeBackendPreference).catch((err) => {
        console.error("Background runtime update failed:", err);
      });
    }
  }

  unloadModel(): Promise<void> {
    return this.runtime.stopServer();
  }

  listSessions(): ChatSession[] {
    return this.store.listSessions();
  }

  createSession(mode: "chat" | "agent" = "chat", title?: string): ChatSession {
    return this.store.createSession(mode, title, this.settings.get().defaultParams);
  }

  updateSession(session: ChatSession): ChatSession {
    return this.store.updateSession(session);
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
   * Detect explicit agent intent prefixes so users can trigger tools without the toggle.
   * Returns cleaned content and whether agent mode should be used.
   */
  static parseAgentIntent(
    content: string,
    preferAgent: boolean,
  ): { content: string; useAgent: boolean } {
    const trimmed = content.trim();
    const prefix = trimmed.match(/^(@agent|\/agent)\b[\s:]*/i);
    if (prefix) {
      return { content: trimmed.slice(prefix[0].length).trim() || trimmed, useAgent: true };
    }
    // Coding / file-creation asks work poorly in plain chat (truncated, no write_file).
    const codingIntent =
      /(напис\p{L}*|напиш\p{L}*|созда\p{L}*|сдела\p{L}*|реализ\p{L}*|постро\p{L}*).{0,80}(игр[уыае]|программ|скрипт|файл|проект|приложение|tetris|тетрис)/iu.test(
        trimmed,
      ) ||
      /\b(write|create|implement|build)\b.{0,80}\b(game|app|file|script|python|tetris)\b/i.test(
        trimmed,
      );
    return { content: trimmed, useAgent: preferAgent || codingIntent };
  }

  async sendChat(
    sessionId: string,
    content: string,
    params?: Partial<GenerationParams>,
  ): Promise<ChatMessage> {
    if (this.agent.isRunning()) {
      throw new Error("Агент ещё выполняется. Остановите его перед обычным чатом.");
    }
    const session = this.store.listSessions().find((s) => s.id === sessionId);
    if (!session) throw new Error("Сессия не найдена");
    this.noteGenerationStart();
    const merged = { ...session.params, ...params };
    const result = await this.chat.send(sessionId, content, merged, session.systemPrompt);
    this.maybeRenameSession(session, content);
    return result;
  }

  /**
   * Unified path: one conversation can do plain completions or the agent/tool loop.
   * When useAgent is true, returns void (progress via agent events); otherwise returns assistant message.
   */
  async sendMessage(
    sessionId: string,
    content: string,
    opts?: { useAgent?: boolean; params?: Partial<GenerationParams> },
  ): Promise<ChatMessage | void> {
    const parsed = AppService.parseAgentIntent(content, Boolean(opts?.useAgent));
    if (!parsed.content) throw new Error("Пустое сообщение");
    if (parsed.useAgent) {
      await this.startAgent(sessionId, parsed.content);
      return;
    }
    return this.sendChat(sessionId, parsed.content, opts?.params);
  }

  stopGeneration(): void {
    this.chat.stop();
    this.agent.cancel();
  }

  /** Approx local tok/s while streaming when server metrics are unavailable. */
  noteGenerationStart(): void {
    this.resetGenStats();
    this.genStats.startedAt = Date.now();
  }

  async startAgent(sessionId: string, content: string): Promise<void> {
    if (this.agent.isRunning()) {
      throw new Error("Агент уже выполняется");
    }
    if (this.chat.isBusy()) {
      this.chat.stop();
    }
    const session = this.store.listSessions().find((s) => s.id === sessionId);
    if (!session) throw new Error("Сессия не найдена");
    this.noteGenerationStart();
    this.maybeRenameSession(session, content);
    await this.agent.run(
      sessionId,
      content,
      this.settings.get(),
      session.params,
      session.systemPrompt,
    );
  }

  resolveConfirmation(
    confirmationId: string,
    approved: boolean,
    rememberForSession?: boolean,
  ): void {
    this.agent.resolveConfirmation(confirmationId, approved, rememberForSession);
  }

  cancelAgent(): void {
    this.agent.cancel();
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

  importSession(bundle: SessionExportBundle): ChatSession {
    return this.store.importSession(bundle);
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
    return previewWriteDiff(filePath, content);
  }

  async getMonitorSnapshot(): Promise<MonitorSnapshot> {
    const st = this.runtime.getStatus();
    const model = this.modelsCache.find((m) => m.id === st.loadedModelId);
    const vram = await sampleVram();
    const total = os.totalmem() / 1024 ** 3;
    const free = os.freemem() / 1024 ** 3;
    const busy = this.chat.isBusy() || this.agent.isRunning();

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
      modelName: model?.name || null,
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

import type {
  AgentConfirmation,
  AgentEvent,
  AppSettings,
  AppView,
  ChatMessage,
  ChatSession,
  GenerationParams,
  HfFile,
  HfSearchResult,
  InstalledRuntime,
  LocalModel,
  McpHealthResult,
  McpServerConfig,
  HardwareLoadSuggestion,
  HfCliStatus,
  ModelRecommendationsReport,
  RuntimeAsset,
  RuntimeBackend,
  RuntimeStatus,
  RuntimeUpdateInfo,
  SessionExportBundle,
  SystemInfo,
} from "./types.js";

export const IPC = {
  getSystemInfo: "kovi:getSystemInfo",
  getSettings: "kovi:getSettings",
  saveSettings: "kovi:saveSettings",
  getRuntimeStatus: "kovi:getRuntimeStatus",
  detectRuntimeAsset: "kovi:detectRuntimeAsset",
  installRuntime: "kovi:installRuntime",
  checkRuntimeUpdate: "kovi:checkRuntimeUpdate",
  ensureLatestRuntime: "kovi:ensureLatestRuntime",
  listModels: "kovi:listModels",
  scanModels: "kovi:scanModels",
  deleteModel: "kovi:deleteModel",
  getModelRecommendations: "kovi:getModelRecommendations",
  suggestHardwareLoadSettings: "kovi:suggestHardwareLoadSettings",
  applyHardwareLoadSettings: "kovi:applyHardwareLoadSettings",
  searchHf: "kovi:searchHf",
  listHfFiles: "kovi:listHfFiles",
  downloadHfFile: "kovi:downloadHfFile",
  getHfCliStatus: "kovi:getHfCliStatus",
  ensureHfCli: "kovi:ensureHfCli",
  loadModel: "kovi:loadModel",
  unloadModel: "kovi:unloadModel",
  listSessions: "kovi:listSessions",
  createSession: "kovi:createSession",
  updateSession: "kovi:updateSession",
  deleteSession: "kovi:deleteSession",
  getMessages: "kovi:getMessages",
  sendChat: "kovi:sendChat",
  sendMessage: "kovi:sendMessage",
  stopGeneration: "kovi:stopGeneration",
  startAgent: "kovi:startAgent",
  resolveConfirmation: "kovi:resolveConfirmation",
  cancelAgent: "kovi:cancelAgent",
  pickDirectory: "kovi:pickDirectory",
  pickFile: "kovi:pickFile",
  getStatusBar: "kovi:getStatusBar",
  getMonitorSnapshot: "kovi:getMonitorSnapshot",
  openMonitorWindow: "kovi:openMonitorWindow",
  setMonitorAlwaysOnTop: "kovi:setMonitorAlwaysOnTop",
  exportSession: "kovi:exportSession",
  importSession: "kovi:importSession",
  getErrorLog: "kovi:getErrorLog",
  checkMcpHealth: "kovi:checkMcpHealth",
  verifyGguf: "kovi:verifyGguf",
  previewFileDiff: "kovi:previewFileDiff",
  runtimeProgress: "kovi:runtimeProgress",
  downloadProgress: "kovi:downloadProgress",
  chatToken: "kovi:chatToken",
  agentEvent: "kovi:agentEvent",
  monitorUpdate: "kovi:monitorUpdate",
} as const;

export interface MonitorSnapshot {
  modelName: string | null;
  loadedModelId: string | null;
  backend: RuntimeBackend | null;
  runtimeTag: string | null;
  serverPort: number | null;
  serverRunning: boolean;
  busy: boolean;
  vramUsedGb: number | null;
  vramTotalGb: number | null;
  gpuUtilPercent: number | null;
  ramUsedGb: number | null;
  ramTotalGb: number | null;
  runtimeDownloading: boolean;
  runtimeProgress: number;
  runtimeLabel: string;
  modelDownloading: boolean;
  modelProgress: number;
  modelLabel: string;
  tokensPerSecond: number | null;
  promptTokensPerSecond: number | null;
  contextUsed: number | null;
  contextSize: number | null;
  metricsSource: string;
  lastError: string | null;
  runtimeLastCheckAt: string | null;
  updateAvailable: boolean;
  latestTag: string | null;
  checkedAt: string;
}

export interface StatusBarInfo {
  modelName: string | null;
  loadedModelId: string | null;
  backend: RuntimeBackend | null;
  serverPort: number | null;
  vramUsedGb: number | null;
  vramTotalGb: number | null;
  ramUsedGb: number | null;
  ramTotalGb: number | null;
  view: AppView;
  tokensPerSecond: number | null;
  agentStepLabel: string | null;
  busy: boolean;
  lastError: string | null;
}

export interface SendChatRequest {
  sessionId: string;
  content: string;
  params?: Partial<GenerationParams>;
}

/** @deprecated Prefer sendMessage + stopGeneration. */
export interface StartAgentRequest {
  sessionId: string;
  content: string;
}

/** Unified send: plain chat or agent/tool loop in one session. */
export interface SendMessageRequest {
  sessionId: string;
  content: string;
  useAgent?: boolean;
  params?: Partial<GenerationParams>;
}

export interface ResolveConfirmationRequest {
  confirmationId: string;
  approved: boolean;
  rememberForSession?: boolean;
}

export interface KoviApi {
  getSystemInfo(): Promise<SystemInfo>;
  getSettings(): Promise<AppSettings>;
  saveSettings(settings: AppSettings): Promise<AppSettings>;
  getRuntimeStatus(): Promise<RuntimeStatus>;
  detectRuntimeAsset(backend?: RuntimeBackend | "auto"): Promise<RuntimeAsset>;
  installRuntime(backend?: RuntimeBackend | "auto"): Promise<InstalledRuntime>;
  checkRuntimeUpdate(backend?: RuntimeBackend | "auto"): Promise<RuntimeUpdateInfo>;
  ensureLatestRuntime(
    backend?: RuntimeBackend | "auto",
    force?: boolean,
  ): Promise<{
    updated: boolean;
    installed: InstalledRuntime;
    update: RuntimeUpdateInfo;
  }>;
  listModels(): Promise<LocalModel[]>;
  scanModels(): Promise<LocalModel[]>;
  /** Delete local GGUF from disk (unloads first if active). */
  deleteModel(modelId: string): Promise<LocalModel[]>;
  getModelRecommendations(): Promise<ModelRecommendationsReport>;
  suggestHardwareLoadSettings(opts?: {
    modelId?: string;
  }): Promise<HardwareLoadSuggestion>;
  applyHardwareLoadSettings(opts?: {
    modelId?: string;
    applyBackend?: boolean;
    applyDefaultParams?: boolean;
  }): Promise<AppSettings>;
  searchHf(query: string): Promise<HfSearchResult[]>;
  listHfFiles(modelId: string): Promise<HfFile[]>;
  downloadHfFile(modelId: string, filePath: string): Promise<string>;
  getHfCliStatus(): Promise<HfCliStatus>;
  ensureHfCli(): Promise<HfCliStatus>;
  loadModel(modelId: string, params?: Partial<GenerationParams>): Promise<void>;
  unloadModel(): Promise<void>;
  listSessions(): Promise<ChatSession[]>;
  createSession(mode?: "chat" | "agent", title?: string): Promise<ChatSession>;
  updateSession(session: ChatSession): Promise<ChatSession>;
  deleteSession(sessionId: string): Promise<void>;
  getMessages(sessionId: string): Promise<ChatMessage[]>;
  /** @deprecated Prefer sendMessage. */
  sendChat(req: SendChatRequest): Promise<ChatMessage>;
  /** Fire-and-forget; progress via onAgentEvent. */
  sendMessage(req: SendMessageRequest): Promise<void>;
  stopGeneration(): Promise<void>;
  /** @deprecated Prefer sendMessage({ useAgent: true }). */
  startAgent(req: StartAgentRequest): Promise<void>;
  resolveConfirmation(req: ResolveConfirmationRequest): Promise<void>;
  /** @deprecated Alias of stopGeneration. */
  cancelAgent(): Promise<void>;
  pickDirectory(): Promise<string | null>;
  pickFile(filters?: { name: string; extensions: string[] }[]): Promise<string | null>;
  getStatusBar(): Promise<StatusBarInfo>;
  getMonitorSnapshot(): Promise<MonitorSnapshot>;
  openMonitorWindow(): Promise<void>;
  setMonitorAlwaysOnTop(flag: boolean): Promise<boolean>;
  exportSession(sessionId: string): Promise<SessionExportBundle>;
  importSession(bundle: SessionExportBundle): Promise<ChatSession>;
  getErrorLog(): Promise<string>;
  checkMcpHealth(server?: McpServerConfig): Promise<McpHealthResult[]>;
  verifyGguf(modelId: string): Promise<LocalModel>;
  previewFileDiff(path: string, content: string): Promise<string>;
  onRuntimeProgress(cb: (p: { progress: number; label: string }) => void): () => void;
  onDownloadProgress(cb: (p: { progress: number; label: string }) => void): () => void;
  onChatToken(cb: (p: { sessionId: string; text: string; thinking?: boolean }) => void): () => void;
  onAgentEvent(cb: (p: { sessionId: string; event: AgentEvent }) => void): () => void;
  onMonitorUpdate(cb: (p: MonitorSnapshot) => void): () => void;
}

declare global {
  interface Window {
    kovi: KoviApi;
  }
}

export {};

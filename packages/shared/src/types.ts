export type RuntimeBackend = "cuda" | "vulkan" | "cpu";

export type FileAccessMode = "project" | "disk";

export type AppView =
  | "chat"
  | "models"
  | "runtime"
  | "mcp"
  | "settings";

/** @deprecated Kept for session migration; UI no longer has a separate Agent view. */
export type LegacyAppView = AppView | "agent";

export type ThemePreset = "light" | "dark" | "high-contrast" | "custom";

/** Agent confirmation policy. */
export type AgentRiskMode = "ask" | "auto-safe" | "full";

export interface ThemeCustom {
  accent: string;
  background: string;
  surface: string;
  text: string;
  radius: number;
  density: "compact" | "comfortable";
}

export interface SystemInfo {
  os: string;
  arch: string;
  cpuModel: string;
  cpuCores: number;
  totalRamGb: number;
  freeRamGb: number;
  gpus: GpuInfo[];
  hasNvidia: boolean;
  hasVulkan: boolean;
  recommendedBackend: RuntimeBackend;
  cudaVersion?: string;
}

export interface GpuInfo {
  name: string;
  vendor: string;
  vramGb?: number;
  index: number;
}

export interface RuntimeAsset {
  tag: string;
  backend: RuntimeBackend;
  assetName: string;
  url: string;
  size?: number;
  sha256?: string;
  cudartAssetName?: string;
  cudartUrl?: string;
  cudartSize?: number;
  cudartSha256?: string;
}

export interface InstalledRuntime {
  tag: string;
  backend: RuntimeBackend;
  path: string;
  serverPath: string;
  installedAt: string;
}

export interface RuntimeUpdateInfo {
  updateAvailable: boolean;
  currentTag: string | null;
  latestTag: string | null;
  latestAsset: RuntimeAsset | null;
  checkedAt: string | null;
  message: string;
}

export interface RuntimeStatus {
  installed: InstalledRuntime | null;
  downloading: boolean;
  downloadProgress: number;
  downloadLabel: string;
  serverRunning: boolean;
  serverPort: number | null;
  loadedModelId: string | null;
  lastError: string | null;
  update: RuntimeUpdateInfo | null;
}

export interface LocalModel {
  id: string;
  name: string;
  path: string;
  sizeBytes: number;
  quant?: string;
  architecture?: string;
  mmprojPath?: string;
  directory: string;
  recommendedNgl: number;
  recommendedContext: number;
  fitsInVram?: boolean;
  /** Quick GGUF header validation. */
  integrityOk?: boolean | null;
  integrityError?: string;
}

export interface HfSearchResult {
  id: string;
  modelId: string;
  downloads: number;
  likes: number;
  tags: string[];
  lastModified?: string;
}

export interface HfFile {
  path: string;
  size: number;
  isGguf: boolean;
  recommended?: boolean;
}

export interface ChatMessage {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  thinking?: string;
  toolCallId?: string;
  toolName?: string;
  attachments?: ChatAttachment[];
  createdAt: string;
  parentId?: string;
}

export interface ChatAttachment {
  id: string;
  name: string;
  mime: string;
  path: string;
  size: number;
}

export interface ChatSession {
  id: string;
  title: string;
  /**
   * Legacy field: "agent" sessions remain valid and map to toolsEnabled=true.
   * New sessions are created as "chat"; per-message agent use is preferred.
   */
  mode: "chat" | "agent";
  /** When true, composer defaults to agent/tools mode for this session. */
  toolsEnabled?: boolean;
  systemPrompt: string;
  modelId?: string;
  pinned: boolean;
  folder?: string;
  createdAt: string;
  updatedAt: string;
  params: GenerationParams;
}

export function sessionToolsEnabled(session: ChatSession): boolean {
  if (typeof session.toolsEnabled === "boolean") return session.toolsEnabled;
  return session.mode === "agent";
}

export interface GenerationParams {
  temperature: number;
  topP: number;
  topK: number;
  minP: number;
  maxTokens: number;
  context: number;
  gpuLayers: number;
  seed: number | null;
  /** Pass --flash-attn to llama-server when true. */
  flashAttn?: boolean;
}

/** Named load preset for GPU layers / context / flash-attn. */
export interface LoadProfile {
  id: string;
  name: string;
  gpuLayers: number;
  context: number;
  flashAttn: boolean;
  maxTokens?: number;
}

export interface AgentPlanStep {
  id: string;
  title: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  detail?: string;
}

export interface AgentConfirmation {
  id: string;
  toolName: string;
  summary: string;
  args: Record<string, unknown>;
  risk: "medium" | "high";
  createdAt: string;
  /** Unified diff preview for write/patch tools. */
  diff?: string;
}

export type AgentEvent =
  | { type: "plan"; steps: AgentPlanStep[] }
  | { type: "step_start"; stepId: string }
  | { type: "step_done"; stepId: string; detail?: string }
  | { type: "tool_call"; name: string; args: Record<string, unknown>; callId: string }
  | { type: "tool_result"; callId: string; result: string; isError?: boolean }
  | { type: "confirmation_required"; confirmation: AgentConfirmation }
  | { type: "token"; text: string }
  | { type: "thinking"; text: string }
  | { type: "done"; messageId: string }
  | { type: "error"; message: string }
  | { type: "cancelled" };

export interface McpServerConfig {
  id: string;
  name: string;
  enabled: boolean;
  transport: "stdio" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export interface McpHealthResult {
  serverId: string;
  name: string;
  ok: boolean;
  toolCount: number;
  message: string;
  checkedAt: string;
}

export interface SessionExportBundle {
  version: 1;
  exportedAt: string;
  session: ChatSession;
  messages: ChatMessage[];
}

export interface AppSettings {
  language: "ru" | "en";
  themePreset: ThemePreset;
  themeCustom: ThemeCustom;
  modelRoots: string[];
  downloadDir: string;
  fileAccessMode: FileAccessMode;
  projectRoot: string | null;
  runtimeBackendPreference: RuntimeBackend | "auto";
  /** Automatically download/install newest llama.cpp (throttled). */
  autoUpdateRuntime: boolean;
  /** ISO timestamp of last successful runtime update check. */
  runtimeLastCheckAt?: string | null;
  /** Optional GitHub token to avoid unauthenticated API rate limits. */
  githubToken?: string;
  openaiProxyEnabled: boolean;
  openaiProxyPort: number;
  webSearchProvider: "duckduckgo" | "searxng";
  searxngUrl?: string;
  webSearchApiKey?: string;
  mcpServers: McpServerConfig[];
  agentMaxSteps: number;
  defaultParams: GenerationParams;
  /** First-run wizard completed. */
  onboardingCompleted: boolean;
  /** Ask = confirm medium+high; auto-safe = auto medium in project; full = skip most confirms. */
  agentRiskMode: AgentRiskMode;
  /** Named model-load presets. */
  loadProfiles: LoadProfile[];
  activeLoadProfileId: string | null;
  /** Known session folder labels (UI catalog). */
  sessionFolders: string[];
}

export const DEFAULT_GENERATION_PARAMS: GenerationParams = {
  temperature: 0.7,
  topP: 0.95,
  topK: 40,
  minP: 0.05,
  maxTokens: 4096,
  context: 8192,
  gpuLayers: 99,
  seed: null,
  flashAttn: false,
};

export const DEFAULT_LOAD_PROFILES: LoadProfile[] = [
  {
    id: "balanced",
    name: "Баланс",
    gpuLayers: 99,
    context: 8192,
    flashAttn: false,
    maxTokens: 2048,
  },
  {
    id: "max-quality",
    name: "Макс. качество",
    gpuLayers: 99,
    context: 16384,
    flashAttn: true,
    maxTokens: 4096,
  },
  {
    id: "low-vram",
    name: "Мало VRAM",
    gpuLayers: 20,
    context: 4096,
    flashAttn: false,
    maxTokens: 1024,
  },
  {
    id: "cpu",
    name: "Только CPU",
    gpuLayers: 0,
    context: 4096,
    flashAttn: false,
    maxTokens: 1024,
  },
];

export const DEFAULT_THEME_CUSTOM: ThemeCustom = {
  accent: "#2a4bff",
  background: "#e7ebf0",
  surface: "#f7f8fb",
  text: "#12141a",
  radius: 12,
  density: "comfortable",
};

export const MCP_PRESETS: Array<Omit<McpServerConfig, "id" | "enabled"> & { id: string; blurb: string }> = [
  {
    id: presetId("filesystem"),
    name: "Filesystem",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem"],
    blurb: "Чтение/запись файлов через MCP (нужен путь в args).",
  },
  {
    id: presetId("memory"),
    name: "Memory",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
    blurb: "Простая память ключ→значение.",
  },
  {
    id: presetId("fetch"),
    name: "Fetch",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-fetch"],
    blurb: "HTTP fetch для агента.",
  },
];

function presetId(slug: string): string {
  return `preset-${slug}`;
}

export function createDefaultSettings(appData: string): AppSettings {
  return {
    language: "ru",
    themePreset: "light",
    themeCustom: { ...DEFAULT_THEME_CUSTOM },
    modelRoots: ["C:\\Models\\LFM"],
    downloadDir: `${appData}\\models`,
    fileAccessMode: "project",
    projectRoot: null,
    runtimeBackendPreference: "auto",
    autoUpdateRuntime: true,
    runtimeLastCheckAt: null,
    githubToken: "",
    openaiProxyEnabled: false,
    openaiProxyPort: 3928,
    webSearchProvider: "duckduckgo",
    mcpServers: [],
    agentMaxSteps: 40,
    defaultParams: { ...DEFAULT_GENERATION_PARAMS },
    onboardingCompleted: false,
    agentRiskMode: "ask",
    loadProfiles: DEFAULT_LOAD_PROFILES.map((p) => ({ ...p })),
    activeLoadProfileId: "balanced",
    sessionFolders: [],
  };
}

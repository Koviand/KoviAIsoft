import { z } from "zod";
import type {
  AppSettings,
  ChatSession,
  GenerationParams,
  SessionExportBundle,
} from "./types.js";
import { isThemePreset } from "./types.js";

const resolveConfirmationSchema = z.object({
  confirmationId: z.string().min(1),
  approved: z.boolean(),
  rememberForSession: z.boolean().optional(),
});

export function assertResolveConfirmation(req: unknown): {
  confirmationId: string;
  approved: boolean;
  rememberForSession?: boolean;
} {
  const parsed = resolveConfirmationSchema.safeParse(req);
  if (!parsed.success) {
    throw new Error(`Некорректное подтверждение: ${parsed.error.issues[0]?.message || "ошибка"}`);
  }
  return parsed.data;
}

const chatAttachmentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  mime: z.string().min(1),
  path: z.string().min(1),
  size: z.number().nonnegative(),
});

const chatMessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string(),
  createdAt: z.string().min(1),
  toolName: z.string().optional(),
  toolCallId: z.string().optional(),
  thinking: z.string().optional(),
  parentId: z.string().optional(),
  attachments: z.array(chatAttachmentSchema).optional(),
});

const chatSessionSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    mode: z.enum(["chat", "agent"]),
    systemPrompt: z.string(),
    params: z.record(z.unknown()),
    pinned: z.boolean().optional(),
    modelId: z.string().optional(),
    folder: z.string().optional(),
    toolsEnabled: z.boolean().optional(),
    agentScratchpad: z.string().optional(),
  })
  .passthrough();

const sessionExportSchema = z.object({
  version: z.literal(1),
  exportedAt: z.string().min(1),
  session: chatSessionSchema,
  messages: z.array(chatMessageSchema).max(2000),
});

export function assertSessionExportBundle(bundle: unknown): SessionExportBundle {
  const parsed = sessionExportSchema.safeParse(bundle);
  if (!parsed.success) {
    throw new Error(
      `Некорректный импорт сессии: ${parsed.error.issues[0]?.message || "ошибка схемы"}`,
    );
  }
  return parsed.data as unknown as SessionExportBundle;
}

const sessionPatchSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().max(200).optional(),
    mode: z.enum(["chat", "agent"]).optional(),
    toolsEnabled: z.boolean().optional(),
    systemPrompt: z.string().max(100_000).optional(),
    modelId: z.string().optional(),
    pinned: z.boolean().optional(),
    folder: z.string().max(200).optional(),
    params: z.record(z.unknown()).optional(),
  })
  .strip();

export type SessionPatch = {
  id: string;
  title?: string;
  mode?: ChatSession["mode"];
  toolsEnabled?: boolean;
  systemPrompt?: string;
  modelId?: string;
  pinned?: boolean;
  /** Empty string clears the folder. */
  folder?: string;
  params?: Partial<GenerationParams>;
};

/** Whitelist session fields from renderer — strips agentScratchpad / createdAt / etc. */
export function assertSessionPatch(x: unknown): SessionPatch {
  const parsed = sessionPatchSchema.safeParse(x);
  if (!parsed.success) {
    throw new Error(
      `Некорректная сессия: ${parsed.error.issues[0]?.message || "ошибка"}`,
    );
  }
  const d = parsed.data;
  const out: SessionPatch = {
    id: d.id,
    title: d.title,
    mode: d.mode,
    toolsEnabled: d.toolsEnabled,
    systemPrompt: d.systemPrompt,
    modelId: d.modelId,
    pinned: d.pinned,
    params: d.params as Partial<GenerationParams> | undefined,
  };
  // Preserve empty string so UI can clear folder (undefined would mean «no change»).
  const rawFolder = (x as { folder?: unknown }).folder;
  if (typeof rawFolder === "string") out.folder = rawFolder;
  return out;
}

export function assertChatAttachments(x: unknown): import("./types.js").ChatAttachment[] {
  if (x == null) return [];
  const parsed = z.array(chatAttachmentSchema).safeParse(x);
  if (!parsed.success) {
    throw new Error(
      `Некорректные вложения: ${parsed.error.issues[0]?.message || "ошибка"}`,
    );
  }
  return parsed.data;
}

/** Deep-ish settings validation for IPC saveSettings. */
export function assertAppSettingsDeep(settings: unknown): AppSettings {
  if (!settings || typeof settings !== "object") {
    throw new Error("Некорректные настройки");
  }
  const s = settings as Record<string, unknown>;
  if (s.projectRoot != null && typeof s.projectRoot !== "string") {
    throw new Error("projectRoot должен быть строкой или null");
  }
  if (!Array.isArray(s.modelRoots) || !s.modelRoots.every((x) => typeof x === "string")) {
    throw new Error("modelRoots должен быть массивом строк");
  }
  if (typeof s.downloadDir !== "string" || !s.downloadDir.trim()) {
    throw new Error("downloadDir должен быть непустой строкой");
  }
  if (s.fileAccessMode !== "project" && s.fileAccessMode !== "disk") {
    throw new Error("fileAccessMode: project | disk");
  }
  if (typeof s.themePreset === "string" && !isThemePreset(s.themePreset)) {
    throw new Error(`Неизвестная тема: ${s.themePreset}`);
  }
  if (!Array.isArray(s.mcpServers)) {
    throw new Error("mcpServers должен быть массивом");
  }
  if (s.hfToken != null && typeof s.hfToken !== "string") {
    throw new Error("hfToken должен быть строкой");
  }
  if (s.githubToken != null && typeof s.githubToken !== "string") {
    throw new Error("githubToken должен быть строкой");
  }
  if (typeof s.openaiProxyPort === "number" && (s.openaiProxyPort < 1 || s.openaiProxyPort > 65535)) {
    throw new Error("openaiProxyPort вне диапазона 1–65535");
  }
  if (
    s.internetAccessMode != null &&
    s.internetAccessMode !== "off" &&
    s.internetAccessMode !== "ask" &&
    s.internetAccessMode !== "allow"
  ) {
    throw new Error("internetAccessMode: off | ask | allow");
  }
  return settings as AppSettings;
}

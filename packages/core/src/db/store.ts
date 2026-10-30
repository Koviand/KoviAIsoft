import fs from "node:fs";
import path from "node:path";
import { v4 as uuid } from "uuid";
import type {
  ChatMessage,
  ChatSession,
  GenerationParams,
  SessionExportBundle,
} from "@kovi/shared";
import { DEFAULT_GENERATION_PARAMS } from "@kovi/shared";
import { writeFileAtomic, writeFileAtomicSync } from "../fsAtomic.js";
import { ensureDir } from "../paths.js";

interface DbShape {
  sessions: ChatSession[];
  messages: Record<string, ChatMessage[]>;
}

const AGENT_SYSTEM =
  "Ты локальный ассистент KoviAIsoft с доступом к инструментам. Когда включён режим агента — сначала составь план, затем вызывай инструменты. Работай только с разрешёнными путями. Отвечай на русском, если пользователь пишет по-русски.";
const CHAT_SYSTEM = "Ты полезный локальный ассистент. Отвечай на языке пользователя.";

function normalizeSession(session: ChatSession): ChatSession {
  const toolsEnabled =
    typeof session.toolsEnabled === "boolean"
      ? session.toolsEnabled
      : session.mode === "agent";
  return {
    ...session,
    toolsEnabled,
    // Keep mode in sync for older builds reading the store.
    mode: toolsEnabled ? "agent" : "chat",
  };
}

export class Store {
  private filePath: string;
  private data: DbShape;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  /** When true, refuse to overwrite disk with empty/new state (I/O failure on load). */
  private blockPersist = false;

  constructor(appData: string) {
    ensureDir(appData);
    this.filePath = path.join(appData, "store.json");
    this.data = this.load();
  }

  private emptyDb(): DbShape {
    return { sessions: [], messages: {} };
  }

  private load(): DbShape {
    if (!fs.existsSync(this.filePath)) {
      return this.emptyDb();
    }
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch (err) {
      // I/O failure: keep empty in-memory but never wipe the on-disk file.
      this.blockPersist = true;
      console.error("[store] failed to read store.json — persist disabled", err);
      return this.emptyDb();
    }
    try {
      const parsed = JSON.parse(raw) as DbShape;
      return {
        sessions: (parsed.sessions || []).map(normalizeSession),
        messages: parsed.messages || {},
      };
    } catch {
      // Corrupt JSON: backup then start fresh (safe to persist).
      try {
        const bak = `${this.filePath}.bak`;
        fs.copyFileSync(this.filePath, bak);
      } catch {
        // ignore backup failure
      }
      return this.emptyDb();
    }
  }

  /** Sync write — used by close/flush. */
  private persistSync(): void {
    if (this.blockPersist) return;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.dirty = false;
    writeFileAtomicSync(this.filePath, JSON.stringify(this.data, null, 2));
  }

  /** Debounced persist to avoid blocking the agent tool loop on every message. */
  private persist(): void {
    if (this.blockPersist) return;
    this.dirty = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      if (!this.dirty || this.blockPersist) return;
      this.dirty = false;
      try {
        writeFileAtomicSync(this.filePath, JSON.stringify(this.data, null, 2));
      } catch {
        this.dirty = true;
        // Retry once shortly after I/O failure.
        setTimeout(() => this.persist(), 250);
      }
    }, 40);
  }

  listSessions(): ChatSession[] {
    return [...this.data.sessions].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
  }

  createSession(
    mode: "chat" | "agent" = "chat",
    title?: string,
    params?: GenerationParams,
  ): ChatSession {
    const now = new Date().toISOString();
    const toolsEnabled = mode === "agent";
    const session: ChatSession = {
      id: uuid(),
      title: title || "Новый диалог",
      mode: toolsEnabled ? "agent" : "chat",
      toolsEnabled,
      systemPrompt: toolsEnabled ? AGENT_SYSTEM : CHAT_SYSTEM,
      pinned: false,
      createdAt: now,
      updatedAt: now,
      params: params || { ...DEFAULT_GENERATION_PARAMS },
    };
    this.data.sessions.unshift(session);
    this.data.messages[session.id] = [];
    this.persist();
    return session;
  }

  updateSession(session: ChatSession): ChatSession {
    const normalized = normalizeSession({
      ...session,
      updatedAt: new Date().toISOString(),
    });
    const idx = this.data.sessions.findIndex((s) => s.id === normalized.id);
    if (idx >= 0) this.data.sessions[idx] = normalized;
    this.persist();
    return normalized;
  }

  setToolsEnabled(sessionId: string, enabled: boolean): ChatSession | null {
    const session = this.data.sessions.find((s) => s.id === sessionId);
    if (!session) return null;
    session.toolsEnabled = enabled;
    session.mode = enabled ? "agent" : "chat";
    // Refresh system prompt only if it still looks like a stock prompt.
    const stock =
      session.systemPrompt === CHAT_SYSTEM || session.systemPrompt === AGENT_SYSTEM;
    if (stock) {
      session.systemPrompt = enabled ? AGENT_SYSTEM : CHAT_SYSTEM;
    }
    return this.updateSession(session);
  }

  deleteSession(sessionId: string): void {
    this.data.sessions = this.data.sessions.filter((s) => s.id !== sessionId);
    delete this.data.messages[sessionId];
    this.persist();
  }

  getMessages(sessionId: string): ChatMessage[] {
    return [...(this.data.messages[sessionId] || [])];
  }

  addMessage(
    sessionId: string,
    message: Omit<ChatMessage, "id" | "createdAt"> & { id?: string; createdAt?: string },
  ): ChatMessage {
    const full: ChatMessage = {
      id: message.id || uuid(),
      role: message.role,
      content: message.content,
      thinking: message.thinking,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      attachments: message.attachments,
      parentId: message.parentId,
      createdAt: message.createdAt || new Date().toISOString(),
    };
    if (!this.data.messages[sessionId]) this.data.messages[sessionId] = [];
    this.data.messages[sessionId].push(full);
    const session = this.data.sessions.find((s) => s.id === sessionId);
    if (session) {
      session.updatedAt = new Date().toISOString();
    }
    this.persist();
    return full;
  }

  exportSession(sessionId: string): SessionExportBundle {
    const session = this.data.sessions.find((s) => s.id === sessionId);
    if (!session) throw new Error("Сессия не найдена");
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      session: structuredClone(session),
      messages: structuredClone(this.data.messages[sessionId] || []),
    };
  }

  importSession(bundle: SessionExportBundle): ChatSession {
    if (!bundle?.session || !Array.isArray(bundle.messages)) {
      throw new Error("Некорректный файл экспорта сессии");
    }
    const now = new Date().toISOString();
    const id = uuid();
    const session = normalizeSession({
      ...bundle.session,
      id,
      title: bundle.session.title?.startsWith("[импорт]")
        ? bundle.session.title
        : `[импорт] ${bundle.session.title || "Диалог"}`,
      createdAt: now,
      updatedAt: now,
    });
    this.data.sessions.unshift(session);
    this.data.messages[id] = bundle.messages.map((m) => ({
      ...m,
      id: m.id || uuid(),
      createdAt: m.createdAt || now,
    }));
    this.persist();
    return session;
  }

  close(): void {
    this.persistSync();
  }

  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.dirty = false;
    await writeFileAtomic(this.filePath, JSON.stringify(this.data, null, 2));
  }
}

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { v4 as uuid } from "uuid";
import type { ChatMessage, ChatSession, GenerationParams } from "@kovi/shared";
import { DEFAULT_GENERATION_PARAMS } from "@kovi/shared";
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

  constructor(appData: string) {
    ensureDir(appData);
    this.filePath = path.join(appData, "store.json");
    this.data = this.load();
  }

  private load(): DbShape {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as DbShape;
      return {
        sessions: (parsed.sessions || []).map(normalizeSession),
        messages: parsed.messages || {},
      };
    } catch {
      return { sessions: [], messages: {} };
    }
  }

  /** Sync write — used by close/flush. */
  private persistSync(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.dirty = false;
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf8");
  }

  /** Debounced persist to avoid blocking the agent tool loop on every message. */
  private persist(): void {
    this.dirty = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      if (!this.dirty) return;
      this.dirty = false;
      try {
        fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf8");
      } catch {
        this.dirty = true;
      }
    }, 80);
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

  close(): void {
    this.persistSync();
  }

  async flush(): Promise<void> {
    this.persistSync();
    await fsp.writeFile(this.filePath, JSON.stringify(this.data, null, 2), "utf8");
  }
}

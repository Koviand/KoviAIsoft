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
import {
  loadSqliteDb,
  migrateJsonToSqlite,
  persistSqliteBinary,
  type DbShape,
} from "./sqliteBackend.js";

const AGENT_SYSTEM =
  "Ты локальный ассистент KoviAIsoft с доступом к инструментам. Когда включён режим агента — сначала составь план, затем вызывай инструменты. Работай только с разрешёнными путями. Отвечай на русском, если пользователь пишет по-русски.";
const CHAT_SYSTEM = "Ты полезный локальный ассистент. Отвечай на языке пользователя.";

/** Cap persisted tool payloads so huge terminal/read_file dumps do not freeze persist. */
export const MAX_PERSISTED_TOOL_CHARS = 20_000;

function clampToolContent(role: string, content: string): string {
  if (role !== "tool" || content.length <= MAX_PERSISTED_TOOL_CHARS) return content;
  const omitted = content.length - MAX_PERSISTED_TOOL_CHARS;
  return `${content.slice(0, MAX_PERSISTED_TOOL_CHARS)}\n…[обрезано ${omitted} симв.]`;
}

function normalizeSession(session: ChatSession): ChatSession {
  const toolsEnabled =
    typeof session.toolsEnabled === "boolean"
      ? session.toolsEnabled
      : session.mode === "agent";
  return {
    ...session,
    toolsEnabled,
    mode: toolsEnabled ? "agent" : "chat",
    pinned: Boolean(session.pinned),
  };
}

type SqlDb = Awaited<ReturnType<typeof loadSqliteDb>>["db"];

export class Store {
  private jsonPath: string;
  private sqlitePath: string;
  private data: DbShape;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private blockPersist = false;
  private db: SqlDb | null = null;
  private sqlReady: Promise<void>;

  constructor(appData: string) {
    ensureDir(appData);
    this.jsonPath = path.join(appData, "store.json");
    this.sqlitePath = path.join(appData, "store.sqlite");
    this.data = this.loadJsonFallback();
    this.sqlReady = this.initSqlite();
  }

  /** Await SQLite init / JSON→SQLite migration (call from AppService.init). */
  async ready(): Promise<void> {
    await this.sqlReady;
  }

  private emptyDb(): DbShape {
    return { sessions: [], messages: {} };
  }

  private loadJsonFallback(): DbShape {
    if (!fs.existsSync(this.jsonPath)) {
      return this.emptyDb();
    }
    try {
      const raw = fs.readFileSync(this.jsonPath, "utf8");
      const parsed = JSON.parse(raw) as DbShape;
      return {
        sessions: (parsed.sessions || []).map(normalizeSession),
        messages: parsed.messages || {},
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      // Corrupt JSON: backup and allow rewrite. Unreadable path (EISDIR/EACCES): block persist.
      if (code === "EISDIR" || code === "EACCES" || code === "EPERM") {
        this.blockPersist = true;
        console.error("[store] failed to read store.json — persist disabled", err);
        return this.emptyDb();
      }
      try {
        fs.copyFileSync(this.jsonPath, `${this.jsonPath}.bak`);
      } catch {
        /* ignore backup failure */
      }
      console.error("[store] corrupt store.json — backed up to .bak, starting empty", err);
      return this.emptyDb();
    }
  }

  private async initSqlite(): Promise<void> {
    try {
      const { db } = await loadSqliteDb(this.sqlitePath);
      this.db = db;
      const migrated = migrateJsonToSqlite(this.jsonPath, this.sqlitePath, db);
      if (migrated) {
        this.data = {
          sessions: migrated.sessions.map(normalizeSession),
          messages: migrated.messages,
        };
        this.blockPersist = false;
        return;
      }
      if (fs.existsSync(this.sqlitePath)) {
        const { readDbShape } = await import("./sqliteBackend.js");
        const fromSql = readDbShape(db);
        const sqlHas =
          fromSql.sessions.length > 0 || Object.keys(fromSql.messages).length > 0;
        if (!sqlHas) return;
        // Prefer whichever file is newer so a failed SQLite write cannot wipe fresher JSON.
        let preferSql = true;
        try {
          if (fs.existsSync(this.jsonPath)) {
            const jsonM = fs.statSync(this.jsonPath).mtimeMs;
            const sqlM = fs.statSync(this.sqlitePath).mtimeMs;
            preferSql = sqlM >= jsonM;
          }
        } catch {
          preferSql = true;
        }
        if (preferSql) {
          this.data = {
            sessions: fromSql.sessions.map(normalizeSession),
            messages: fromSql.messages,
          };
        } else {
          // Keep JSON-loaded this.data; rewrite SQLite on next persist.
          this.dirty = true;
          this.persist();
        }
      }
    } catch (err) {
      console.error("[store] sqlite init failed — using JSON only", err);
      this.db = null;
    }
  }

  private persistSync(): void {
    if (this.blockPersist) return;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.dirty = false;
    try {
      writeFileAtomicSync(this.jsonPath, JSON.stringify(this.data, null, 2));
    } catch {
      /* keep trying sqlite */
    }
    if (this.db) {
      try {
        persistSqliteBinary(this.sqlitePath, this.db, this.data);
      } catch (err) {
        console.error("[store] sqlite persist failed", err);
      }
    }
  }

  private persist(): void {
    if (this.blockPersist) return;
    this.dirty = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      if (!this.dirty || this.blockPersist) return;
      this.dirty = false;
      try {
        this.persistSync();
      } catch {
        this.dirty = true;
        setTimeout(() => this.persist(), 250);
      }
    }, 40);
  }

  listSessions(): ChatSession[] {
    return [...this.data.sessions]
      .map((s) => normalizeSession(s))
      .sort((a, b) => {
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
      content: clampToolContent(message.role, message.content),
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

  exportSessionFolder(folder: string): SessionExportBundle[] {
    const name = folder.trim();
    const ids = this.data.sessions
      .filter((s) => (s.folder || "").trim() === name)
      .map((s) => s.id);
    return ids.map((id) => this.exportSession(id));
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
    const idMap = new Map<string, string>();
    for (const m of bundle.messages) {
      if (m?.id) idMap.set(m.id, uuid());
    }
    this.data.messages[id] = bundle.messages.map((m) => {
      const newId = (m.id && idMap.get(m.id)) || uuid();
      const parentId =
        m.parentId && idMap.has(m.parentId) ? idMap.get(m.parentId)! : undefined;
      return {
        ...m,
        id: newId,
        parentId,
        createdAt: m.createdAt || now,
      };
    });
    this.persist();
    return session;
  }

  close(): void {
    this.persistSync();
    try {
      this.db?.close();
    } catch {
      /* ignore */
    }
  }

  async flush(): Promise<void> {
    await this.ready();
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.dirty = false;
    await writeFileAtomic(this.jsonPath, JSON.stringify(this.data, null, 2));
    if (this.db) {
      persistSqliteBinary(this.sqlitePath, this.db, this.data);
    }
  }
}

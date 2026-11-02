import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { ChatMessage, ChatSession } from "@kovi/shared";

const nodeRequire = createRequire(__filename);

export type DbShape = {
  sessions: ChatSession[];
  messages: Record<string, ChatMessage[]>;
};

type SqlJsDatabase = {
  run: (sql: string, params?: unknown[]) => void;
  exec: (sql: string) => Array<{ columns: string[]; values: unknown[][] }>;
  export: () => Uint8Array;
  close: () => void;
};

let SQL: { Database: new (data?: ArrayLike<number> | null) => SqlJsDatabase } | null = null;

async function ensureSql(): Promise<typeof SQL> {
  if (SQL) return SQL;
  const initSqlJs = nodeRequire("sql.js");
  const wasmPath = nodeRequire.resolve("sql.js/dist/sql-wasm.wasm");
  SQL = await initSqlJs({
    locateFile: () => wasmPath,
  });
  return SQL;
}

function createSchema(db: SqlJsDatabase): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
  `);
}

export async function loadSqliteDb(sqlitePath: string): Promise<{
  db: SqlJsDatabase;
  data: DbShape;
}> {
  const sql = await ensureSql();
  if (!sql) throw new Error("sql.js failed to init");
  let db: SqlJsDatabase;
  if (fs.existsSync(sqlitePath)) {
    const buf = fs.readFileSync(sqlitePath);
    db = new sql.Database(buf);
  } else {
    db = new sql.Database();
  }
  createSchema(db);
  const data = readDbShape(db);
  return { db, data };
}

export function readDbShape(db: SqlJsDatabase): DbShape {
  const sessions: ChatSession[] = [];
  const messages: Record<string, ChatMessage[]> = {};
  try {
    const sRows = db.exec("SELECT json FROM sessions");
    for (const row of sRows[0]?.values || []) {
      sessions.push(JSON.parse(String(row[0])) as ChatSession);
    }
  } catch {
    /* empty */
  }
  try {
    const mRows = db.exec(
      "SELECT session_id, json FROM messages ORDER BY created_at ASC, rowid ASC",
    );
    for (const row of mRows[0]?.values || []) {
      const sid = String(row[0]);
      const msg = JSON.parse(String(row[1])) as ChatMessage;
      if (!messages[sid]) messages[sid] = [];
      messages[sid].push(msg);
    }
  } catch {
    /* empty */
  }
  return { sessions, messages };
}

export function writeDbShape(db: SqlJsDatabase, data: DbShape): void {
  db.run("BEGIN");
  try {
    db.run("DELETE FROM messages");
    db.run("DELETE FROM sessions");
    for (const s of data.sessions) {
      db.run("INSERT INTO sessions (id, json) VALUES (?, ?)", [
        s.id,
        JSON.stringify(s),
      ]);
    }
    for (const [sid, list] of Object.entries(data.messages)) {
      for (const m of list) {
        db.run(
          "INSERT INTO messages (id, session_id, json, created_at) VALUES (?, ?, ?, ?)",
          [m.id, sid, JSON.stringify(m), m.createdAt],
        );
      }
    }
    db.run("COMMIT");
  } catch (err) {
    try {
      db.run("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/** Atomic binary write for sql.js WASM export. */
export function persistSqliteBinary(sqlitePath: string, db: SqlJsDatabase, data: DbShape): void {
  writeDbShape(db, data);
  const exported = Buffer.from(db.export());
  const dir = path.dirname(sqlitePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${sqlitePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, exported);
  fs.renameSync(tmp, sqlitePath);
}

export function migrateJsonToSqlite(
  jsonPath: string,
  sqlitePath: string,
  db: SqlJsDatabase,
): DbShape | null {
  if (!fs.existsSync(jsonPath) || fs.existsSync(sqlitePath)) return null;
  try {
    const raw = fs.readFileSync(jsonPath, "utf8");
    const parsed = JSON.parse(raw) as DbShape;
    const data: DbShape = {
      sessions: parsed.sessions || [],
      messages: parsed.messages || {},
    };
    persistSqliteBinary(sqlitePath, db, data);
    try {
      fs.copyFileSync(jsonPath, `${jsonPath}.migrated.bak`);
    } catch {
      /* ignore */
    }
    return data;
  } catch {
    return null;
  }
}

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { type ChildProcess, spawn } from "node:child_process";
import { findLfmGgufPath } from "./embeddingCatalog.js";
import { getAppDataDir } from "../paths.js";

async function findFreePort(start = 8190): Promise<number> {
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
  throw new Error("Не удалось найти свободный порт для embedding-server");
}

async function waitForEmbeddings(port: number, timeoutMs = 90_000): Promise<void> {
  const start = Date.now();
  let lastErr = "";
  while (Date.now() - start < timeoutMs) {
    try {
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      if (health.ok) return;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: "ping", model: "local" }),
      });
      // Ready only on success (or empty-input validation that still proves route).
      if (res.ok || res.status === 400) return;
      lastErr = `HTTP ${res.status}`;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`Embedding server не ответил: ${lastErr || "timeout"}`);
}

export type EmbeddingServerDeps = {
  getServerPath: () => string | null;
  getGgufPath?: () => string | null;
  appData?: string;
};

/**
 * Second llama-server process dedicated to --embeddings (does not replace chat runtime).
 */
export class EmbeddingServer {
  private child: ChildProcess | null = null;
  private port: number | null = null;
  private baseUrl: string | null = null;
  private loadedGguf: string | null = null;
  private flag: "--embeddings" | "--embedding" = "--embeddings";
  private deps: EmbeddingServerDeps;
  private startLock: Promise<string> | null = null;
  private serverLog = "";

  constructor(deps: EmbeddingServerDeps) {
    this.deps = deps;
  }

  setDeps(deps: EmbeddingServerDeps): void {
    this.deps = deps;
  }

  getBaseUrl(): string | null {
    return this.baseUrl;
  }

  getServerLog(): string {
    return this.serverLog;
  }

  isRunning(): boolean {
    return Boolean(this.child && this.baseUrl && !this.child.killed);
  }

  private appendLog(chunk: string): void {
    this.serverLog = (this.serverLog + chunk).slice(-12_000);
  }

  async ensureRunning(): Promise<string> {
    if (this.startLock) return this.startLock;
    this.startLock = this.ensureRunningInner().finally(() => {
      this.startLock = null;
    });
    return this.startLock;
  }

  private async ensureRunningInner(): Promise<string> {
    const gguf =
      this.deps.getGgufPath?.() ??
      findLfmGgufPath(this.deps.appData ?? getAppDataDir());
    if (!gguf || !fs.existsSync(gguf)) {
      throw new Error("LFM2.5 GGUF не найден — скачайте модель эмбеддингов");
    }
    const serverPath = this.deps.getServerPath();
    if (!serverPath || !fs.existsSync(serverPath)) {
      throw new Error("llama-server не установлен (нужен runtime)");
    }

    if (this.isRunning() && this.loadedGguf === gguf && this.baseUrl) {
      try {
        await waitForEmbeddings(this.port!, 5_000);
        return this.baseUrl;
      } catch {
        await this.stop();
      }
    }

    await this.stop();
    const port = await findFreePort(8190);
    await this.spawnWithFlag(serverPath, gguf, port, this.flag);
    try {
      await waitForEmbeddings(port);
    } catch (firstErr) {
      const alt: "--embeddings" | "--embedding" =
        this.flag === "--embeddings" ? "--embedding" : "--embeddings";
      this.flag = alt;
      await this.stop();
      await this.spawnWithFlag(serverPath, gguf, port, alt);
      try {
        await waitForEmbeddings(port);
      } catch {
        await this.stop();
        const detail = this.serverLog.trim().slice(-400);
        throw new Error(
          `${firstErr instanceof Error ? firstErr.message : String(firstErr)}${
            detail ? `\n${detail}` : ""
          }`,
        );
      }
    }
    this.port = port;
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.loadedGguf = gguf;
    return this.baseUrl;
  }

  private async spawnWithFlag(
    serverPath: string,
    gguf: string,
    port: number,
    flag: "--embeddings" | "--embedding",
  ): Promise<void> {
    const args = [
      "-m",
      gguf,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      flag,
      "-ngl",
      "0",
    ];
    const cwd = path.dirname(serverPath);
    this.serverLog = "";
    this.child = spawn(serverPath, args, {
      cwd,
      windowsHide: true,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const onChunk = (buf: Buffer) => this.appendLog(buf.toString());
    this.child.stderr?.on("data", onChunk);
    this.child.stdout?.on("data", onChunk);
    this.child.on("error", (err) => {
      this.appendLog(`\n[spawn error] ${err.message}\n`);
    });
    this.child.on("exit", (code, signal) => {
      this.appendLog(`\n[exit code=${code} signal=${signal}]\n`);
      if (this.child) {
        this.child = null;
        this.baseUrl = null;
        this.port = null;
        this.loadedGguf = null;
      }
    });
  }

  private l2Normalize(v: Float32Array): Float32Array {
    let n = 0;
    for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!;
    n = Math.sqrt(n) || 1;
    const out = new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = v[i]! / n;
    return out;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (!texts.length) return [];
    const base = await this.ensureRunning();
    const out: Float32Array[] = [];
    const batchSize = 16;
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const res = await fetch(`${base}/v1/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: batch.length === 1 ? batch[0] : batch,
          model: "local",
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`embeddings HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      const json = (await res.json()) as {
        data?: Array<{ embedding?: number[]; index?: number }>;
      };
      const rows = [...(json.data || [])].sort(
        (a, b) => (a.index ?? 0) - (b.index ?? 0),
      );
      if (rows.length !== batch.length) {
        throw new Error(
          `embeddings: ожидалось ${batch.length} векторов, получено ${rows.length}`,
        );
      }
      for (const row of rows) {
        const emb = row.embedding;
        if (!emb?.length) throw new Error("embeddings: пустой вектор");
        out.push(this.l2Normalize(Float32Array.from(emb)));
      }
    }
    return out;
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.baseUrl = null;
    this.port = null;
    this.loadedGguf = null;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      child.once("exit", done);
      try {
        child.kill();
      } catch {
        resolve();
        return;
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
        resolve();
      }, 2000);
    });
  }
}

let sharedServer: EmbeddingServer | null = null;

export function getSharedEmbeddingServer(deps?: EmbeddingServerDeps): EmbeddingServer {
  if (!sharedServer) {
    sharedServer = new EmbeddingServer(
      deps ?? {
        getServerPath: () => null,
        appData: getAppDataDir(),
      },
    );
  } else if (deps) {
    sharedServer.setDeps(deps);
  }
  return sharedServer;
}

export function configureEmbeddingServer(deps: EmbeddingServerDeps): EmbeddingServer {
  if (sharedServer) {
    sharedServer.setDeps(deps);
    return sharedServer;
  }
  sharedServer = new EmbeddingServer(deps);
  return sharedServer;
}

export async function stopSharedEmbeddingServer(): Promise<void> {
  if (sharedServer) {
    await sharedServer.stop();
  }
}

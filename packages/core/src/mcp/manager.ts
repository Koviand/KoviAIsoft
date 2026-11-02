import { createRequire } from "node:module";
import type { McpHealthResult, McpServerConfig } from "@kovi/shared";

export interface McpToolInfo {
  serverId: string;
  name: string;
  description?: string;
  inputSchema?: unknown;
}

type McpClient = {
  connect: (transport: unknown) => Promise<void>;
  listTools: () => Promise<{ tools?: Array<{ name: string; description?: string; inputSchema?: unknown }> }>;
  callTool: (args: { name: string; arguments: Record<string, unknown> }) => Promise<unknown>;
  close: () => Promise<void>;
};

const MCP_CONNECT_TIMEOUT_MS = 10_000;
const MCP_CLOSE_TIMEOUT_MS = 3_000;
/** Prevent a stuck MCP tool from hanging the agent loop forever. */
const MCP_CALL_TIMEOUT_MS = 75_000;

const requireFromHere = createRequire(__filename);

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: timeout ${ms}ms`)), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function loadMcp(): {
  Client: new (info: { name: string; version: string }) => McpClient;
  StdioClientTransport: new (opts: {
    command: string;
    args?: string[];
    env?: Record<string, string>;
  }) => unknown;
  SSEClientTransport: new (url: URL) => unknown;
} {
  const clientMod = requireFromHere("@modelcontextprotocol/sdk/client");
  const stdioMod = requireFromHere("@modelcontextprotocol/sdk/client/stdio.js");
  const sseMod = requireFromHere("@modelcontextprotocol/sdk/client/sse.js");
  return {
    Client: clientMod.Client,
    StdioClientTransport: stdioMod.StdioClientTransport,
    SSEClientTransport: sseMod.SSEClientTransport,
  };
}

function buildSafeEnv(cfgEnv?: Record<string, string>): Record<string, string> {
  const allowKeys = [
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "LANG",
    "ComSpec",
  ];
  const safeEnv: Record<string, string> = {};
  for (const k of allowKeys) {
    const v = process.env[k];
    if (typeof v === "string") safeEnv[k] = v;
  }
  for (const [k, v] of Object.entries(cfgEnv || {})) {
    if (typeof v === "string") safeEnv[k] = v;
  }
  return safeEnv;
}

export class McpManager {
  private clients = new Map<string, McpClient>();
  private tools: McpToolInfo[] = [];

  listTools(): McpToolInfo[] {
    return [...this.tools];
  }

  async sync(configs: McpServerConfig[]): Promise<void> {
    await this.closeAll();
    this.tools = [];
    let sdk: ReturnType<typeof loadMcp>;
    try {
      sdk = loadMcp();
    } catch (err) {
      console.error("MCP SDK unavailable", err);
      return;
    }

    const enabled = configs.filter((c) => c.enabled);
    const settled = await Promise.allSettled(
      enabled.map(async (cfg) => {
        const client = new sdk.Client({ name: "KoviAIsoft", version: "0.1.0" });
        try {
          if (cfg.transport === "stdio") {
            if (!cfg.command) return;
            const transport = new sdk.StdioClientTransport({
              command: cfg.command,
              args: cfg.args || [],
              env: buildSafeEnv(cfg.env),
            });
            await withTimeout(
              client.connect(transport),
              MCP_CONNECT_TIMEOUT_MS,
              `MCP ${cfg.name} connect`,
            );
          } else {
            if (!cfg.url) return;
            const transport = new sdk.SSEClientTransport(new URL(cfg.url));
            await withTimeout(
              client.connect(transport),
              MCP_CONNECT_TIMEOUT_MS,
              `MCP ${cfg.name} connect`,
            );
          }
          const listed = await withTimeout(
            client.listTools(),
            MCP_CONNECT_TIMEOUT_MS,
            `MCP ${cfg.name} listTools`,
          );
          this.clients.set(cfg.id, client);
          for (const t of listed.tools || []) {
            this.tools.push({
              serverId: cfg.id,
              name: `mcp_${cfg.id}_${t.name}`,
              description: t.description,
              inputSchema: t.inputSchema,
            });
          }
        } catch (err) {
          console.error(`MCP connect failed for ${cfg.name}`, err);
          try {
            await withTimeout(client.close(), MCP_CLOSE_TIMEOUT_MS, `MCP ${cfg.name} close`);
          } catch {
            /* ignore */
          }
        }
      }),
    );
    for (const r of settled) {
      if (r.status === "rejected") {
        console.error("MCP sync worker failed", r.reason);
      }
    }
  }

  async callTool(fullName: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.tools.find((t) => t.name === fullName);
    if (!tool) throw new Error(`MCP tool not found: ${fullName}`);
    const client = this.clients.get(tool.serverId);
    if (!client) throw new Error(`MCP server not connected: ${tool.serverId}`);
    const rawName = fullName.replace(`mcp_${tool.serverId}_`, "");
    try {
      const result = await withTimeout(
        client.callTool({ name: rawName, arguments: args }),
        MCP_CALL_TIMEOUT_MS,
        `MCP ${tool.serverId}/${rawName}`,
      );
      const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
      if (Array.isArray(content)) {
        return content.map((c) => c.text || JSON.stringify(c)).join("\n");
      }
      return JSON.stringify(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/timeout|таймаут/i.test(msg)) {
        // Drop hung client so the next call reconnects via sync.
        this.clients.delete(tool.serverId);
        this.tools = this.tools.filter((t) => t.serverId !== tool.serverId);
        try {
          await withTimeout(client.close(), MCP_CLOSE_TIMEOUT_MS, `MCP ${tool.serverId} close`);
        } catch {
          /* ignore */
        }
      }
      throw err;
    }
  }

  async closeAll(): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    this.tools = [];
    await Promise.all(
      clients.map(async (client) => {
        try {
          await withTimeout(client.close(), MCP_CLOSE_TIMEOUT_MS, "mcp close");
        } catch {
          /* ignore */
        }
      }),
    );
  }

  /** Probe one or more MCP servers without mutating the live tool set. */
  async healthCheck(configs: McpServerConfig[]): Promise<McpHealthResult[]> {
    let sdk: ReturnType<typeof loadMcp>;
    try {
      sdk = loadMcp();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return configs.map((cfg) => ({
        serverId: cfg.id,
        name: cfg.name,
        ok: false,
        toolCount: 0,
        message: `MCP SDK недоступен: ${message}`,
        checkedAt: new Date().toISOString(),
      }));
    }

    const results: McpHealthResult[] = [];
    for (const cfg of configs) {
      const checkedAt = new Date().toISOString();
      let client: McpClient | null = null;
      try {
        client = new sdk.Client({ name: "KoviAIsoft-health", version: "0.1.0" });
        if (cfg.transport === "stdio") {
          if (!cfg.command) throw new Error("Не задана команда stdio");
          const transport = new sdk.StdioClientTransport({
            command: cfg.command,
            args: cfg.args || [],
            env: buildSafeEnv(cfg.env),
          });
          await withTimeout(
            client.connect(transport),
            MCP_CONNECT_TIMEOUT_MS,
            `MCP health ${cfg.name}`,
          );
        } else {
          if (!cfg.url) throw new Error("Не задан URL SSE");
          const transport = new sdk.SSEClientTransport(new URL(cfg.url));
          await withTimeout(
            client.connect(transport),
            MCP_CONNECT_TIMEOUT_MS,
            `MCP health ${cfg.name}`,
          );
        }
        const listed = await withTimeout(
          client.listTools(),
          MCP_CONNECT_TIMEOUT_MS,
          `MCP health ${cfg.name} listTools`,
        );
        const toolCount = listed.tools?.length || 0;
        results.push({
          serverId: cfg.id,
          name: cfg.name,
          ok: true,
          toolCount,
          message: `OK · ${toolCount} tools`,
          checkedAt,
        });
      } catch (err) {
        results.push({
          serverId: cfg.id,
          name: cfg.name,
          ok: false,
          toolCount: 0,
          message: err instanceof Error ? err.message : String(err),
          checkedAt,
        });
      } finally {
        try {
          if (client) {
            await withTimeout(client.close(), MCP_CLOSE_TIMEOUT_MS, "mcp health close");
          }
        } catch {
          // ignore
        }
      }
    }
    return results;
  }
}

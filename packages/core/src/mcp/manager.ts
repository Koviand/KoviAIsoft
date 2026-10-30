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

const requireFromHere = createRequire(__filename);

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

    for (const cfg of configs.filter((c) => c.enabled)) {
      try {
        const client = new sdk.Client({ name: "KoviAIsoft", version: "0.1.0" });
        if (cfg.transport === "stdio") {
          if (!cfg.command) continue;
          // Allowlist env — never pass full process.env (tokens/secrets) (P1-17).
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
          for (const [k, v] of Object.entries(cfg.env || {})) {
            if (typeof v === "string") safeEnv[k] = v;
          }
          const transport = new sdk.StdioClientTransport({
            command: cfg.command,
            args: cfg.args || [],
            env: safeEnv,
          });
          await client.connect(transport);
        } else {
          if (!cfg.url) continue;
          const transport = new sdk.SSEClientTransport(new URL(cfg.url));
          await client.connect(transport);
        }
        this.clients.set(cfg.id, client);
        const listed = await client.listTools();
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
      }
    }
  }

  async callTool(fullName: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.tools.find((t) => t.name === fullName);
    if (!tool) throw new Error(`MCP tool not found: ${fullName}`);
    const client = this.clients.get(tool.serverId);
    if (!client) throw new Error(`MCP server not connected: ${tool.serverId}`);
    const rawName = fullName.replace(`mcp_${tool.serverId}_`, "");
    const result = await client.callTool({ name: rawName, arguments: args });
    const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
    if (Array.isArray(content)) {
      return content.map((c) => c.text || JSON.stringify(c)).join("\n");
    }
    return JSON.stringify(result);
  }

  async closeAll(): Promise<void> {
    for (const client of this.clients.values()) {
      try {
        await client.close();
      } catch {
        // ignore
      }
    }
    this.clients.clear();
    this.tools = [];
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
            env: { ...process.env, ...(cfg.env || {}) } as Record<string, string>,
          });
          await client.connect(transport);
        } else {
          if (!cfg.url) throw new Error("Не задан URL SSE");
          const transport = new sdk.SSEClientTransport(new URL(cfg.url));
          await client.connect(transport);
        }
        const listed = await client.listTools();
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
          await client?.close();
        } catch {
          // ignore
        }
      }
    }
    return results;
  }
}

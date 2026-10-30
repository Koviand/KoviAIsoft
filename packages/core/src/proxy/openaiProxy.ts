import http from "node:http";
import type { RuntimeManager } from "../runtime/manager.js";

export class OpenAiProxy {
  private server: http.Server | null = null;
  private port: number | null = null;

  constructor(private runtime: RuntimeManager) {}

  getPort(): number | null {
    return this.port;
  }

  async start(port: number): Promise<void> {
    await this.stop();
    this.server = http.createServer(async (req, res) => {
      const base = this.runtime.getOpenAiBaseUrl();
      if (!base) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Model not loaded" }));
        return;
      }
      // Optional bearer for local proxy (P2-9): KOVI_PROXY_TOKEN
      const required = process.env.KOVI_PROXY_TOKEN?.trim();
      if (required) {
        const auth = String(req.headers.authorization || "");
        const got = auth.replace(/^Bearer\s+/i, "").trim();
        if (got !== required) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }
      }
      try {
        const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
        const target = `${base}${url.pathname}${url.search}`.replace(/\/v1\/v1/, "/v1");
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = Buffer.concat(chunks);
        const upstream = await fetch(target, {
          method: req.method,
          headers: {
            "Content-Type": req.headers["content-type"] || "application/json",
            Authorization: "Bearer sk-no-key",
          },
          body: ["GET", "HEAD"].includes(req.method || "GET") ? undefined : body,
        });
        res.writeHead(upstream.status, {
          "Content-Type": upstream.headers.get("content-type") || "application/json",
        });
        if (upstream.body) {
          const reader = upstream.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(Buffer.from(value));
          }
        }
        res.end();
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, "127.0.0.1", () => {
        this.port = port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const srv = this.server;
    this.server = null;
    this.port = null;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RUNTIME_CHECK_INTERVAL_MS } from "../packages/core/src/appService";
import { RuntimeManager } from "../packages/core/src/runtime/manager";

describe("runtime throttle + portable meta", () => {
  it("uses 24h check interval", () => {
    expect(RUNTIME_CHECK_INTERVAL_MS).toBe(24 * 60 * 60 * 1000);
  });

  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it("stores relative paths and resolves them after hydrate", async () => {
    const appData = fs.mkdtempSync(path.join(os.tmpdir(), "kovi-rt-"));
    dirs.push(appData);
    const runtimes = path.join(appData, "runtimes");
    const installDir = path.join(runtimes, "b12000-cuda");
    fs.mkdirSync(installDir, { recursive: true });
    const server = path.join(installDir, "llama-server.exe");
    fs.writeFileSync(server, "fake");

    const mgr = new RuntimeManager(appData);
    // Simulate write via private path by installing meta through ensureInstalled reuse path:
    // call install with pre-created folder — install early-returns when server exists.
    // We can't easily inject asset without network; write meta file directly then refresh.
    const metaPath = path.join(runtimes, "installed.json");
    fs.writeFileSync(
      metaPath,
      JSON.stringify(
        {
          tag: "b12000",
          backend: "cuda",
          path: "b12000-cuda",
          serverPath: "b12000-cuda/llama-server.exe",
          installedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );

    const refreshed = mgr.refreshInstalled();
    expect(refreshed?.tag).toBe("b12000");
    expect(path.isAbsolute(refreshed!.serverPath)).toBe(true);
    expect(fs.existsSync(refreshed!.serverPath)).toBe(true);
  });

  it("migrates absolute installed paths when folder still exists", () => {
    const appData = fs.mkdtempSync(path.join(os.tmpdir(), "kovi-rt-abs-"));
    dirs.push(appData);
    const runtimes = path.join(appData, "runtimes");
    const installDir = path.join(runtimes, "b11969-cuda");
    fs.mkdirSync(installDir, { recursive: true });
    const server = path.join(installDir, "llama-server.exe");
    fs.writeFileSync(server, "fake");
    fs.writeFileSync(
      path.join(runtimes, "installed.json"),
      JSON.stringify({
        tag: "b11969",
        backend: "cuda",
        path: installDir,
        serverPath: server,
        installedAt: new Date().toISOString(),
      }),
      "utf8",
    );

    const mgr = new RuntimeManager(appData);
    const meta = mgr.getStatus().installed;
    expect(meta?.tag).toBe("b11969");
    expect(fs.existsSync(meta!.serverPath)).toBe(true);
  });
});

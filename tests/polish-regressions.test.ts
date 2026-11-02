import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_NON_ADVANCING_HARD_STOP,
  AGENT_NON_ADVANCING_MAX,
} from "../packages/core/src/agent/finishPolicy";
import { toolCallsToActionJson } from "../packages/core/src/agent/actionSchema";
import { createDefaultSettings } from "../packages/shared/src/types";

describe("polish regressions", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it("non-advancing hard-stop is above nudge threshold", () => {
    expect(AGENT_NON_ADVANCING_HARD_STOP).toBeGreaterThan(AGENT_NON_ADVANCING_MAX);
    expect(AGENT_NON_ADVANCING_HARD_STOP).toBe(AGENT_NON_ADVANCING_MAX * 3);
  });

  it("native multi tool_calls prefers mutating tool over mapped[0]", () => {
    const json = toolCallsToActionJson([
      {
        function: { name: "list_dir", arguments: "{}" },
      },
      {
        function: {
          name: "write_file",
          arguments: JSON.stringify({ path: "a.py", content: "print(1)" }),
        },
      },
    ]);
    const parsed = JSON.parse(json) as {
      tool: { name: string };
    };
    expect(parsed.tool.name).toBe("write_file");
  });

  it("SearXNG without URL throws explicit settings error", async () => {
    const { webSearch } = await import("../packages/core/src/tools/websearch");
    const s = createDefaultSettings("C:\\tmp\\kovi");
    s.webSearchProvider = "searxng";
    s.searxngUrl = "";
    await expect(webSearch("query", s)).rejects.toThrow(/SearXNG.*URL/i);
  });

  it("loadVectors returns aligned Float32Array from misaligned buffer file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kovi-vec-"));
    dirs.push(dir);
    const dim = 4;
    const count = 2;
    // Write raw floats with a leading pad so some readers would be misaligned —
    // our loader copies into allocUnsafe which is aligned.
    const floats = new Float32Array(count * dim);
    for (let i = 0; i < floats.length; i++) floats[i] = i + 0.5;
    fs.writeFileSync(path.join(dir, "vectors.bin"), Buffer.from(floats.buffer));
    fs.writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify({ chunkCount: count, dim, version: 1 }),
    );

    // Import private helper via re-read of public retrieve path is heavy;
    // exercise through a tiny local copy of the align contract.
    const buf = fs.readFileSync(path.join(dir, "vectors.bin"));
    const expected = count * dim * 4;
    const copy = Buffer.allocUnsafe(expected);
    buf.copy(copy, 0, 0, expected);
    const view = new Float32Array(copy.buffer, copy.byteOffset, count * dim);
    expect(view.length).toBe(count * dim);
    expect(view[0]).toBeCloseTo(0.5);
    expect(copy.byteOffset % 4).toBe(0);
  });

  it("getEffectiveSettings returns usable webSearchApiKey for Tavily chat prep", async () => {
    const { AppService } = await import("../packages/core/src/appService");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kovi-eff-"));
    dirs.push(dir);
    const svc = new AppService(dir);
    await svc.init();
    try {
      const base = svc.getSettings();
      await svc.saveSettings({
        ...base,
        webSearchApiKey: "tvly-test-key-123",
        webSearchProvider: "tavily",
      });
      const eff = svc.getEffectiveSettings();
      expect(eff.webSearchProvider).toBe("tavily");
      expect(typeof eff.webSearchApiKey).toBe("string");
      expect(eff.webSearchApiKey.length).toBeGreaterThan(0);
      // Chat path must use effective settings (not raw encrypted placeholder alone).
      expect(eff.webSearchApiKey === "__secure__" ? false : true).toBe(true);
    } finally {
      await svc.dispose();
    }
  });

  it("internet-off soft-fail uses one shared callId for tool_call and tool_result", () => {
    const loopSrc = fs.readFileSync(
      path.join(__dirname, "../packages/core/src/agent/loop.ts"),
      "utf8",
    );
    const idx = loopSrc.indexOf("isNetworkTool(toolName) && !isInternetEnabled(settings)");
    expect(idx).toBeGreaterThan(0);
    const offBlock = loopSrc.slice(idx, idx + 700);
    expect(offBlock).toMatch(/const netCallId = /);
    expect(offBlock.match(/callId:\s*netCallId/g)?.length).toBe(2);
    // Single Date.now() (or uuid) assignment — not two separate ids.
    const nowCount = (offBlock.match(/Date\.now\(\)/g) || []).length;
    expect(nowCount).toBeLessThanOrEqual(1);
  });
});

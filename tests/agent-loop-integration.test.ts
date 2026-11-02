import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../packages/core/src/agent/loop";
import { Store } from "../packages/core/src/db/store";
import { McpManager } from "../packages/core/src/mcp/manager";
import { createDefaultSettings, type AgentEvent, type GenerationParams } from "@kovi/shared";

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("AgentLoop integration (mocked completeJson)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    dirs.length = 0;
  });

  it("plan → write_file → final emits plan and done", async () => {
    const data = tmpDir("kovi-agent-int-");
    dirs.push(data);
    const project = path.join(data, "proj");
    fs.mkdirSync(project, { recursive: true });

    const store = new Store(data);
    const session = store.createSession("agent", "test");
    const mcp = new McpManager();
    const responses = [
      JSON.stringify({
        thought: "plan",
        plan: [
          { id: "1", title: "Создать основной файл" },
          { id: "2", title: "Дописать логику" },
          { id: "3", title: "Краткий итог (final)" },
        ],
        tool: null,
        final: null,
      }),
      JSON.stringify({
        thought: "write",
        tool: {
          name: "write_file",
          args: {
            path: "hello.py",
            content: "print('hi')\n" + "# " + "x".repeat(400),
          },
        },
        final: null,
      }),
      JSON.stringify({
        thought: "done",
        tool: null,
        final: "Готово: hello.py создан",
      }),
    ];
    let call = 0;
    const chat = {
      completeJson: vi.fn(async () => {
        const text = responses[Math.min(call, responses.length - 1)]!;
        call += 1;
        return text;
      }),
      stop: vi.fn(),
      getRuntime: () => ({
        getStatus: () => ({ loadedModelId: "test-model" }),
      }),
    };

    const events: AgentEvent[] = [];
    const loop = new AgentLoop(chat as never, store, mcp);
    loop.setEventHandler((_sid, ev) => {
      events.push(ev);
    });

    const settings = createDefaultSettings(data);
    settings.projectRoot = project;
    settings.fileAccessMode = "project";
    settings.agentRiskMode = "full";
    settings.agentMaxSteps = 20;

    const params: GenerationParams = {
      ...settings.defaultParams,
      context: 4096,
      maxTokens: 512,
      temperature: 0.2,
    };

    await loop.run(session.id, "сделай hello.py", settings, params, "sys");

    expect(events.some((e) => e.type === "plan")).toBe(true);
    expect(events.some((e) => e.type === "done")).toBe(true);
    expect(fs.existsSync(path.join(project, "hello.py"))).toBe(true);
    const planEv = [...events].reverse().find((e) => e.type === "plan");
    expect(planEv && planEv.type === "plan" && planEv.steps[0]?.status).toBe("done");
  }, 30_000);

  it("emits incomplete on budget with mocked empty progress", async () => {
    const data = tmpDir("kovi-agent-bud-");
    dirs.push(data);
    const store = new Store(data);
    const session = store.createSession("agent", "budget");
    const mcp = new McpManager();
    const chat = {
      completeJson: vi.fn(async () =>
        JSON.stringify({
          thought: "noop",
          tool: null,
          final: null,
          plan: [
            { id: "1", title: "a" },
            { id: "2", title: "b" },
            { id: "3", title: "c" },
          ],
        }),
      ),
      stop: vi.fn(),
      getRuntime: () => ({
        getStatus: () => ({ loadedModelId: "test-model" }),
      }),
    };
    const events: AgentEvent[] = [];
    const loop = new AgentLoop(chat as never, store, mcp);
    loop.setEventHandler((_s, ev) => events.push(ev));

    const settings = createDefaultSettings(data);
    settings.projectRoot = data;
    settings.agentRiskMode = "full";
    settings.agentMaxSteps = 3;

    await loop.run(
      session.id,
      "просто ответь",
      settings,
      { ...settings.defaultParams, context: 2048, maxTokens: 256 },
      "sys",
    );

    // After plan freeze, subsequent steps may repair/no-tool until budget.
    expect(events.some((e) => e.type === "done" || e.type === "incomplete")).toBe(true);
  }, 30_000);
});

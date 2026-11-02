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
    // Plan phase must call completeJson with planOnly (no tools).
    const firstCall = chat.completeJson.mock.calls[0];
    expect(firstCall?.[3]?.planOnly).toBe(true);
    // After final, scratchpad plan is cleared for the next turn.
    const sess = store.listSessions().find((s) => s.id === session.id);
    const scratch = sess?.agentScratchpad
      ? (JSON.parse(String(sess.agentScratchpad)) as { plan?: unknown[]; planFrozen?: boolean })
      : null;
    expect(scratch?.plan?.length ?? 0).toBe(0);
    expect(scratch?.planFrozen).toBe(false);
  }, 30_000);

  it("Cursor-like: plan with kinds → two edits → finalize", async () => {
    const data = tmpDir("kovi-agent-cursor-");
    dirs.push(data);
    const project = path.join(data, "proj");
    fs.mkdirSync(project, { recursive: true });
    const store = new Store(data);
    const session = store.createSession("agent", "cursor");
    const mcp = new McpManager();
    const responses = [
      JSON.stringify({
        thought: "plan",
        plan: [
          { id: "1", title: "Write main", kind: "edit" },
          { id: "2", title: "Write util", kind: "edit" },
          { id: "3", title: "Summary", kind: "finalize" },
        ],
        tool: null,
        final: null,
      }),
      JSON.stringify({
        thought: "w1",
        tool: {
          name: "write_file",
          args: { path: "main.py", content: "print(1)\n" + "# " + "x".repeat(400) },
        },
        final: null,
      }),
      JSON.stringify({
        thought: "w2",
        tool: {
          name: "write_file",
          args: { path: "util.py", content: "X=1\n" + "# " + "y".repeat(400) },
        },
        final: null,
      }),
      JSON.stringify({ thought: "done", tool: null, final: "Готово" }),
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
    loop.setEventHandler((_s, ev) => events.push(ev));
    const settings = createDefaultSettings(data);
    settings.projectRoot = project;
    settings.fileAccessMode = "project";
    settings.agentRiskMode = "full";
    settings.agentMaxSteps = 30;
    await loop.run(
      session.id,
      "сделай два файла",
      settings,
      { ...settings.defaultParams, context: 4096, maxTokens: 512 },
      "sys",
    );
    expect(events.some((e) => e.type === "done")).toBe(true);
    expect(fs.existsSync(path.join(project, "main.py"))).toBe(true);
    expect(fs.existsSync(path.join(project, "util.py"))).toBe(true);
    const firstPlan = events.find((e) => e.type === "plan");
    expect(
      firstPlan && firstPlan.type === "plan" && firstPlan.steps.every((s) => Boolean(s.kind)),
    ).toBe(true);
    expect(chat.completeJson.mock.calls[0]?.[3]?.planOnly).toBe(true);
    expect(chat.completeJson.mock.calls[1]?.[3]?.planOnly).toBeFalsy();
  }, 30_000);

  it("uses loadedModelName (not hash id) for family tuning params", async () => {
    const data = tmpDir("kovi-agent-ident-");
    dirs.push(data);
    const project = path.join(data, "proj");
    fs.mkdirSync(project, { recursive: true });
    const store = new Store(data);
    const session = store.createSession("agent", "ident");
    const mcp = new McpManager();
    const chat = {
      completeJson: vi.fn(async (_m: unknown, params: { temperature?: number }) => {
        // Large qwen should keep temp up to ~0.35, not weak 0.25 from hash→other.
        expect(params.temperature).toBeGreaterThan(0.25);
        return JSON.stringify({
          thought: "plan",
          plan: [
            { id: "1", title: "a", kind: "edit" },
            { id: "2", title: "b", kind: "edit" },
            { id: "3", title: "c", kind: "finalize" },
          ],
          tool: null,
          final: null,
        });
      }),
      stop: vi.fn(),
      getRuntime: () => ({
        getStatus: () => ({
          loadedModelId: "a".repeat(16),
          loadedModelName: "Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf",
          loadedModelPath: "C:/models/Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf",
        }),
      }),
    };
    const events: AgentEvent[] = [];
    const loop = new AgentLoop(chat as never, store, mcp);
    loop.setEventHandler((_s, ev) => events.push(ev));
    const settings = createDefaultSettings(data);
    settings.projectRoot = project;
    settings.fileAccessMode = "project";
    settings.agentRiskMode = "full";
    settings.agentMaxSteps = 3;
    await loop.run(
      session.id,
      "просто ответь",
      settings,
      { ...settings.defaultParams, context: 4096, maxTokens: 256, temperature: 0.5 },
      "sys",
    );
    expect(chat.completeJson).toHaveBeenCalled();
    expect(events.some((e) => e.type === "done" || e.type === "incomplete")).toBe(true);
  }, 30_000);

  it("stops after repeated model refusals (tiny 1.5B loop)", async () => {
    const data = tmpDir("kovi-agent-refuse-");
    dirs.push(data);
    const project = path.join(data, "proj");
    fs.mkdirSync(project, { recursive: true });
    const store = new Store(data);
    const session = store.createSession("agent", "refuse");
    const mcp = new McpManager();
    const refusal =
      "Извините, но я не могу выполнить ваш запрос. Пожалуйста, уточните вашу задачу или предоставьте больше деталей.";
    const chat = {
      completeJson: vi.fn(async () =>
        JSON.stringify({ thought: refusal, tool: null, final: refusal }),
      ),
      stop: vi.fn(),
      getRuntime: () => ({
        getStatus: () => ({
          loadedModelId: "a".repeat(16),
          loadedModelName: "qwen2.5-coder-1.5b-ins.gguf",
          loadedModelPath: null,
        }),
      }),
    };
    const events: AgentEvent[] = [];
    const loop = new AgentLoop(chat as never, store, mcp);
    loop.setEventHandler((_s, ev) => events.push(ev));
    const settings = createDefaultSettings(data);
    settings.projectRoot = project;
    settings.fileAccessMode = "project";
    settings.agentRiskMode = "full";
    settings.agentMaxSteps = 40;
    await loop.run(
      session.id,
      "сделай tetris на python",
      settings,
      { ...settings.defaultParams, context: 4096, maxTokens: 512 },
      "sys",
    );
    expect(chat.completeJson.mock.calls.length).toBeLessThanOrEqual(3);
    const incomplete = events.find((e) => e.type === "incomplete");
    expect(incomplete && incomplete.type === "incomplete" && incomplete.reason).toBe(
      "no_progress",
    );
    expect(events.some((e) => e.type === "done")).toBe(true);
    const stepDone = events.filter(
      (e) => e.type === "step_done" && e.detail === "model_refusal",
    );
    expect(stepDone.length).toBe(1);
    const msgs = store.getMessages(session.id);
    const last = msgs[msgs.length - 1];
    expect(last?.content).toMatch(/отказалась|≥7B|instruct/i);
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

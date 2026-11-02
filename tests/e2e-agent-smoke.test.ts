import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../packages/core/src/agent/loop";
import { Store } from "../packages/core/src/db/store";
import { McpManager } from "../packages/core/src/mcp/manager";
import {
  restoreCheckpoint,
  saveFileCheckpoint,
} from "../packages/core/src/tools/checkpoints";
import { writeFileTool } from "../packages/core/src/tools/files";
import { createDefaultSettings, type AgentEvent, type GenerationParams } from "@kovi/shared";
import {
  pickConstraintMode,
  toolCallsToActionJson,
} from "../packages/core/src/agent/actionSchema";
import { diagnoseShellFailure } from "../packages/core/src/tools/terminal";
import { normalizeToolsBatch, parseAgentAction } from "../packages/core/src/agent/parseAction";

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("e2e agent / checkpoint / protocol smoke", () => {
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

  it("write → checkpoint → restore", async () => {
    const data = tmpDir("kovi-e2e-cp-");
    dirs.push(data);
    const project = path.join(data, "proj");
    fs.mkdirSync(project, { recursive: true });
    const target = path.join(project, "app.py");
    fs.writeFileSync(target, "print('v1')\n", "utf8");

    const settings = createDefaultSettings(data);
    settings.projectRoot = project;
    settings.fileAccessMode = "project";

    const cp = await saveFileCheckpoint({
      projectRoot: project,
      targetAbs: target,
      runId: "run1",
    });
    expect(cp).toBeTruthy();

    const written = await writeFileTool(
      "app.py",
      "print('v2')\n",
      settings,
      { checkpointRunId: "run2" },
    );
    expect(written).toMatch(/checkpoint:/);
    expect(fs.readFileSync(target, "utf8")).toContain("v2");

    await restoreCheckpoint({
      projectRoot: project,
      checkpointAbsOrRel: cp!,
      settings,
    });
    expect(fs.readFileSync(target, "utf8")).toContain("v1");
  });

  it("mocked agent plan → write creates file", async () => {
    const data = tmpDir("kovi-e2e-agent-");
    dirs.push(data);
    const project = path.join(data, "proj");
    fs.mkdirSync(project, { recursive: true });

    const store = new Store(data);
    await store.ready();
    const session = store.createSession("agent", "e2e");
    const mcp = new McpManager();
    const responses = [
      JSON.stringify({
        thought: "plan",
        plan: [
          { id: "1", title: "Создать файл" },
          { id: "2", title: "Итог" },
        ],
        tool: null,
        final: null,
      }),
      JSON.stringify({
        thought: "write",
        tool: {
          name: "write_file",
          args: { path: "note.txt", content: "e2e-ok\n" },
        },
        final: null,
      }),
      JSON.stringify({
        thought: "done",
        tool: null,
        final: "Готово",
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
    loop.setEventHandler((_sid, ev) => events.push(ev));

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

    await loop.run(session.id, "создай note.txt", settings, params, "sys");
    expect(events.some((e) => e.type === "done")).toBe(true);
    expect(fs.readFileSync(path.join(project, "note.txt"), "utf8")).toContain("e2e-ok");
    store.close();
  });

  it("batch tools[] + native tool_calls map + stderr diag + constraint order", () => {
    const batch = parseAgentAction(
      JSON.stringify({
        thought: "scout",
        tools: [
          { name: "list_dir", args: { path: "." } },
          { name: "git_status", args: {} },
        ],
        final: null,
      }),
    );
    expect(batch?.tools?.length).toBe(2);
    expect(normalizeToolsBatch(batch!.tools!).ok).toBe(true);

    const mapped = toolCallsToActionJson([
      { function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
    ]);
    expect(JSON.parse(mapped).tool.name).toBe("read_file");

    expect(
      pickConstraintMode({
        toolsOk: null,
        jsonSchemaOk: true,
        grammarOk: true,
      }),
    ).toBe("tools");
    expect(
      pickConstraintMode({
        toolsOk: false,
        jsonSchemaOk: false,
        grammarOk: null,
      }),
    ).toBe("grammar");

    const diag = diagnoseShellFailure(
      "python main.py",
      1,
      "",
      "ModuleNotFoundError: No module named 'foo'",
    );
    expect(diag).toMatch(/Диагностика/);
    expect(diag).toMatch(/pip install|модуль/i);
  });
});

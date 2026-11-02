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

describe("e2e agent coding (long mock)", () => {
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

  it(
    "plan -> read -> write -> patch -> terminal fail -> fix -> final",
    async () => {
      const data = tmpDir("kovi-e2e-coding-");
      dirs.push(data);
      const project = path.join(data, "proj");
      fs.mkdirSync(project, { recursive: true });
      fs.writeFileSync(path.join(project, "app.py"), "print('old')\n", "utf8");

      const store = new Store(data);
      await store.ready();
      const session = store.createSession("agent", "coding");
      const mcp = new McpManager();

      const responses = [
        JSON.stringify({
          thought: "plan",
          plan: [
            { id: "1", title: "Prochitat app.py" },
            { id: "2", title: "Obnovit kod" },
            { id: "3", title: "Proverit zapusk" },
            { id: "4", title: "Itog" },
          ],
          tool: null,
          final: null,
        }),
        JSON.stringify({
          thought: "read",
          tool: { name: "read_file", args: { path: "app.py" } },
          final: null,
        }),
        JSON.stringify({
          thought: "rewrite",
          tool: {
            name: "write_file",
            args: {
              path: "app.py",
              content:
                "def main():\n    print('hello')\n\nif __name__ == '__main__':\n    main()\n",
            },
          },
          final: null,
        }),
        JSON.stringify({
          thought: "patch",
          tool: {
            name: "apply_patch",
            args: {
              path: "app.py",
              oldText: "print('hello')",
              newText: "print('hello-world')",
            },
          },
          final: null,
        }),
        JSON.stringify({
          thought: "run",
          tool: {
            name: "run_terminal",
            args: { command: "python nosuch_module_xyz.py", cwd: "." },
          },
          final: null,
        }),
        JSON.stringify({
          thought: "fix path",
          tool: {
            name: "write_file",
            args: {
              path: "app.py",
              content:
                "def main():\n    print('hello-world')\n\nif __name__ == '__main__':\n    main()\n",
            },
          },
          final: null,
        }),
        JSON.stringify({
          thought: "done",
          tool: null,
          final: "Gotovo: app.py obnovlen",
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
          getStatus: () => ({ loadedModelId: "qwen2.5-7b-instruct" }),
        }),
      };

      const events: AgentEvent[] = [];
      const loop = new AgentLoop(chat as never, store, mcp);
      loop.setEventHandler((_sid, ev) => {
        events.push(ev);
        if (ev.type === "confirmation_required") {
          setTimeout(() => {
            loop.resolveConfirmation(ev.confirmation.id, true, false);
          }, 0);
        }
      });

      const settings = createDefaultSettings(data);
      settings.projectRoot = project;
      settings.fileAccessMode = "project";
      settings.agentRiskMode = "full";
      settings.agentMaxSteps = 40;
      settings.agentConfirmTimeoutSec = 30;

      const params: GenerationParams = {
        ...settings.defaultParams,
        context: 4096,
        maxTokens: 512,
        temperature: 0.2,
      };

      await loop.run(session.id, "obnovi app.py", settings, params, "sys");

      expect(events.some((e) => e.type === "plan")).toBe(true);
      expect(events.some((e) => e.type === "done")).toBe(true);
      expect(fs.readFileSync(path.join(project, "app.py"), "utf8")).toMatch(/hello-world/);
      expect(call).toBeGreaterThanOrEqual(6);
      store.close();
    },
    60_000,
  );
});

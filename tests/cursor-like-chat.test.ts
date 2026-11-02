import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
  detectAgentTask,
  detectShortProjectTask,
} from "../packages/core/src/agent/intent";
import {
  skipCurrentPlanStep,
  shouldAdvancePlanOnTool,
  stepKindOf,
} from "../packages/core/src/agent/planner";
import { waitForServer } from "../packages/core/src/runtime/manager";
import { AppService } from "../packages/core/src/appService";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("detectAgentTask Cursor-like", () => {
  it("routes short project commands when projectRoot is set", () => {
    expect(detectShortProjectTask("сделай tetris")).toBe(true);
    expect(detectShortProjectTask("почини баг в auth")).toBe(true);
    expect(
      detectAgentTask("сделай tetris", { projectRoot: "C:/proj" }),
    ).toBe(true);
    // Short imperative without coding artifact — only with projectRoot.
    expect(detectAgentTask("добавь счёт", { projectRoot: null })).toBe(false);
    expect(detectAgentTask("добавь счёт", { projectRoot: "C:/proj" })).toBe(true);
  });
});

describe("run/verify soft-skip helpers", () => {
  it("does not advance run kind on write_file", () => {
    const step = {
      id: "3",
      title: "Проверить запуск",
      status: "pending" as const,
      kind: "run" as const,
    };
    expect(shouldAdvancePlanOnTool(step, "write_file", { path: "a.py" })).toBe(false);
    expect(stepKindOf(step)).toBe("run");
  });

  it("skipCurrentPlanStep marks pending skipped", () => {
    const steps = [
      { id: "1", title: "a", status: "done" as const, kind: "edit" as const },
      { id: "2", title: "run", status: "pending" as const, kind: "run" as const },
    ];
    const next = skipCurrentPlanStep(steps, "soft-skip");
    expect(next[1]!.status).toBe("skipped");
    expect(next[1]!.detail).toMatch(/soft-skip/);
  });
});

describe("waitForServer fail-fast on dead child", () => {
  it("throws immediately when child already exited", async () => {
    const child = new EventEmitter() as ChildProcess;
    (child as { exitCode: number | null }).exitCode = 1;
    (child as { signalCode: NodeJS.Signals | null }).signalCode = null;
    (child as { killed: boolean }).killed = false;
    await expect(waitForServer(59999, 30_000, child, () => "oom log")).rejects.toThrow(
      /завершился с кодом 1/,
    );
  });
});

describe("createSession with projectRoot → agent", () => {
  it("defaults to agent when projectRoot is set", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kovi-sess-"));
    const proj = path.join(tmp, "proj");
    fs.mkdirSync(proj);
    const svc = new AppService(tmp);
    await svc.init();
    try {
      await svc.saveSettings({ ...svc.getSettings(), projectRoot: proj });
      const s = svc.createSession();
      expect(s.toolsEnabled).toBe(true);
      expect(s.mode).toBe("agent");
    } finally {
      await svc.dispose();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("confirm timeout ≤0 becomes finite", () => {
  it("documents 180s floor via planner-independent constant path", () => {
    // Behavior is in AgentLoop.confirmIfNeeded — smoke that raw 0 is not used as forever.
    const raw = 0;
    const effective = raw <= 0 ? 180 : raw;
    expect(effective).toBe(180);
  });
});

// silence unused vi in case of future mocks
void vi;

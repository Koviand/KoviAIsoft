import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AppService } from "../packages/core/src/appService";
import { sessionToolsEnabled } from "../packages/shared/src/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kovi-send-"));

describe("unified send / session tools", () => {
  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("parses @agent / /agent prefixes", () => {
    expect(AppService.parseAgentIntent("hello", false)).toEqual({
      content: "hello",
      useAgent: false,
    });
    expect(AppService.parseAgentIntent("hello", true)).toEqual({
      content: "hello",
      useAgent: true,
    });
    expect(AppService.parseAgentIntent("@agent list files", false)).toEqual({
      content: "list files",
      useAgent: true,
    });
    expect(AppService.parseAgentIntent("/agent: do stuff", false)).toEqual({
      content: "do stuff",
      useAgent: true,
    });
  });

  it("normalizes legacy agent sessions and toolsEnabled", async () => {
    const svc = new AppService(tmp);
    await svc.init();
    const agent = svc.createSession("agent", "legacy-agent");
    expect(agent.toolsEnabled).toBe(true);
    expect(sessionToolsEnabled(agent)).toBe(true);

    const chat = svc.createSession("chat", "plain");
    expect(chat.toolsEnabled).toBe(false);
    expect(sessionToolsEnabled(chat)).toBe(false);

    const toggled = svc.setSessionToolsEnabled(chat.id, true);
    expect(toggled.toolsEnabled).toBe(true);
    expect(toggled.mode).toBe("agent");

    // Unified list includes both modes
    const all = svc.listSessions();
    expect(all.some((s) => s.id === agent.id)).toBe(true);
    expect(all.some((s) => s.id === chat.id)).toBe(true);

    await svc.dispose();
  });
});

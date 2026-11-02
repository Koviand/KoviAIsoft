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

  it("parses @agent / /agent prefixes; chat mode never auto-agents", () => {
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
    expect(AppService.parseAgentIntent("@agent", false).emptyAgentPrefix).toBe(true);

    // preferAgent=false (chat mode): coding intent stays in chat.
    expect(
      AppService.parseAgentIntent(
        "Я хочу чтобы ты написал игру Tetris на Python",
        false,
      ).useAgent,
    ).toBe(false);
    expect(
      AppService.parseAgentIntent("перепиши auth модуль", false, {
        projectRoot: "C:\\proj",
      }).useAgent,
    ).toBe(false);
    expect(
      AppService.parseAgentIntent("привет", false, {
        projectRoot: "C:\\proj",
      }).useAgent,
    ).toBe(false);
    expect(
      AppService.parseAgentIntent("исправь файл main.py", false, {
        projectRoot: "C:\\proj",
      }).useAgent,
    ).toBe(false);
    expect(
      AppService.parseAgentIntent("implement tetris game in python", false).useAgent,
    ).toBe(false);
    expect(
      AppService.parseAgentIntent("запусти npm test", false, {
        projectRoot: "C:\\proj",
      }).useAgent,
    ).toBe(false);
    expect(AppService.parseAgentIntent("запусти npm test", false).useAgent).toBe(false);

    // preferAgent=true (agent mode): coding routes to agent.
    expect(
      AppService.parseAgentIntent("implement tetris game in python", true).useAgent,
    ).toBe(true);
  });

  it(
    "sendMessage respects session toolsEnabled and rejects empty @agent",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kovi-tools-"));
      const svc = new AppService(dir);
      await svc.init();
      try {
        await expect(svc.sendMessage("missing", "@agent")).rejects.toThrow();
        const chat = svc.createSession("chat", "tools-on");
        await expect(svc.sendMessage(chat.id, "@agent")).rejects.toThrow(/@agent/);

        // Chat mode: plain question must NOT start agent.
        let agentStarted = false;
        svc.startAgent = async () => {
          agentStarted = true;
        };
        // Stub chat path so we don't need a loaded model.
        svc.sendChat = async () =>
          ({
            id: "m1",
            sessionId: chat.id,
            role: "assistant",
            content: "ok",
            createdAt: new Date().toISOString(),
          }) as never;
        await svc.sendMessage(chat.id, "просто вопрос без coding");
        expect(agentStarted).toBe(false);

        svc.setSessionToolsEnabled(chat.id, true);
        agentStarted = false;
        await svc.sendMessage(chat.id, "просто вопрос без coding");
        expect(agentStarted).toBe(true);
      } finally {
        await svc.dispose();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it(
    "normalizes legacy agent sessions and toolsEnabled",
    async () => {
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

      const all = svc.listSessions();
      expect(all.some((s) => s.id === agent.id)).toBe(true);
      expect(all.some((s) => s.id === chat.id)).toBe(true);

      await svc.dispose();
    },
    15_000,
  );
});

import { describe, expect, it } from "vitest";
import {
  detectAgentTask,
  detectCodingTask,
  detectLiveWebNeed,
  detectToolAction,
} from "../packages/core/src/agent/intent";
import { AppService } from "../packages/core/src/appService";

describe("agent intent heuristics", () => {
  it("detects coding tasks that must force write_file", () => {
    expect(detectCodingTask("Я хочу чтобы ты написал игру Tetris на Python")).toBe(true);
    expect(detectCodingTask("implement tetris in python")).toBe(true);
    expect(detectCodingTask("перепиши auth модуль")).toBe(true);
    expect(detectCodingTask("сделай игру тетрис")).toBe(true);
    expect(detectCodingTask("привет")).toBe(false);
  });

  it("detects shell/tool actions", () => {
    expect(detectToolAction("запусти npm test", true)).toBe(true);
    expect(detectToolAction("run pytest", false)).toBe(true);
    expect(detectToolAction("list_dir в проекте", false)).toBe(true);
    expect(detectToolAction("привет", true)).toBe(false);
  });

  it("routes combined agent tasks", () => {
    expect(detectAgentTask("fix bug in main.py", { projectRoot: "C:\\p" })).toBe(true);
    expect(detectAgentTask("просто поговорим", { projectRoot: "C:\\p" })).toBe(false);
  });

  it("detects live web needs (weather/news) for plain chat", () => {
    expect(detectLiveWebNeed("Какая сегодня погода в Москве")).toBe(true);
    expect(detectLiveWebNeed("What's the weather in Moscow today?")).toBe(true);
    expect(detectLiveWebNeed("курс доллара сейчас")).toBe(true);
    expect(detectLiveWebNeed("последние новости")).toBe(true);
    expect(detectLiveWebNeed("напиши функцию на python")).toBe(false);
    expect(detectLiveWebNeed("привет")).toBe(false);
  });

  it("parseAgentIntent: chat mode never auto-agents; weather stays chat", () => {
    expect(
      AppService.parseAgentIntent("напиши tetris на python", false, {
        projectRoot: "C:\\p",
      }).useAgent,
    ).toBe(false);
    expect(
      AppService.parseAgentIntent("Какая сегодня погода в Москве", true, {
        projectRoot: "C:\\p",
      }).useAgent,
    ).toBe(false);
    expect(
      AppService.parseAgentIntent("@agent list files", false).useAgent,
    ).toBe(true);
  });

  it("coding tasks that mention weather stay on agent path", () => {
    expect(
      AppService.parseAgentIntent("сделай приложение погоды на React", true, {
        projectRoot: "C:\\p",
      }).useAgent,
    ).toBe(true);
    expect(
      AppService.parseAgentIntent("напиши скрипт курса доллара на python", true, {
        projectRoot: "C:\\p",
      }).useAgent,
    ).toBe(true);
  });
});

describe("compact tools include web_search", () => {
  it("exposes web_search in CORE for low-ctx agent", async () => {
    const { CORE_TOOL_NAMES } = await import("../packages/core/src/agent/toolsCatalog");
    expect(CORE_TOOL_NAMES.has("web_search")).toBe(true);
  });
});

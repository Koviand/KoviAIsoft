import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultSettings } from "../packages/shared/src/types";
import { buildProjectMap } from "../packages/core/src/context/projectMap";
import {
  extractKeywords,
  extractPathMentions,
  retrieveProjectContext,
} from "../packages/core/src/context/retrieve";
import { buildProjectContext, packLayers } from "../packages/core/src/context/packer";
import { condenseTranscript, summarizeTranscript } from "../packages/core/src/context/summarize";
import { estimateTokens } from "../packages/core/src/chat/contextBudget";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kovi-ctx-"));
  temps.push(dir);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "node_modules", "left-pad"), { recursive: true });
  fs.writeFileSync(path.join(dir, "node_modules", "left-pad", "index.js"), "module.exports=1", "utf8");
  fs.writeFileSync(
    path.join(dir, "src", "tetris.py"),
    "import pygame\n\ndef main():\n    print('tetris')\n",
    "utf8",
  );
  fs.writeFileSync(path.join(dir, "src", "utils.ts"), "export const x = 1;\n", "utf8");
  fs.writeFileSync(path.join(dir, "README.md"), "# Demo\n", "utf8");
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "Use pygame for games.\n", "utf8");
  return dir;
}

describe("project context (Cursor-like)", () => {
  it("builds map ignoring node_modules", () => {
    const root = makeProject();
    const map = buildProjectMap(root);
    expect(map.treeText).toMatch(/tetris\.py/);
    expect(map.treeText).not.toMatch(/left-pad/);
    expect(map.files.some((f) => f.includes("tetris.py"))).toBe(true);
  });

  it("extracts @mentions and keywords", () => {
    const root = "C:\\Users\\Kovi\\proj";
    expect(extractPathMentions("смотри @src/tetris.py пожалуйста", root)).toContain(
      "src/tetris.py",
    );
    expect(extractKeywords("Напиши игру Tetris на Python").map((k) => k.toLowerCase())).toEqual(
      expect.arrayContaining(["tetris", "python"]),
    );
  });

  it("retrieves relevant python file for tetris query", async () => {
    const root = makeProject();
    const hits = await retrieveProjectContext(root, "доработай tetris на python pygame");
    expect(hits.some((h) => h.path.includes("tetris.py"))).toBe(true);
    expect(hits[0]!.excerpt).toMatch(/pygame|main/);
  });

  it("packs layers under token budget", () => {
    const packed = packLayers(
      [
        { id: "base", priority: 0, title: "b", content: "BASE" },
        { id: "map", priority: 4, title: "m", content: "MAP ".repeat(5000) },
        { id: "tools", priority: 1, title: "t", content: "TOOLS" },
      ],
      200,
    );
    expect(packed.text).toContain("BASE");
    expect(packed.text).toContain("TOOLS");
    expect(estimateTokens(packed.text)).toBeLessThanOrEqual(220);
    expect(packed.truncatedLayers.length).toBeGreaterThan(0);
  });

  it("buildProjectContext stays within reserve", async () => {
    const root = makeProject();
    const settings = createDefaultSettings(root);
    settings.projectRoot = root;
    settings.fileAccessMode = "project";
    const ctx = await buildProjectContext({
      settings,
      userQuery: "Исправь tetris.py — добавь GUI на pygame",
      baseSystem: "Ты ассистент.",
      toolBlock: "- write_file: писать файлы",
      contextTokens: 4096,
      reserveTokens: 1600,
    });
    expect(ctx.systemPrompt).toMatch(/tetris|Карта|Релевантный|AGENTS/i);
    expect(ctx.stats.usedTokens).toBeLessThan(4096 - 1600 + 80);
  });

  it("condenses long transcripts", () => {
    const msgs = [
      { role: "system", content: "sys" },
      ...Array.from({ length: 20 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content:
          i % 2 === 0
            ? `Результат инструмента write_file:\nWritten 10 chars to C:\\p\\f${i}.py`
            : `{"tool":{"name":"write_file","args":{"path":"f${i}.py"}}}`,
      })),
    ];
    const condensed = condenseTranscript(msgs, { keepRecent: 4, triggerMessages: 8 });
    expect(condensed.length).toBeLessThan(msgs.length);
    expect(condensed.some((m) => /Сжатая история/i.test(m.content))).toBe(true);
    expect(summarizeTranscript(msgs.slice(1, 5))).toMatch(/write_file|user|assistant/i);
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProjectMemory } from "../packages/core/src/agent/projectMemory";

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe("loadProjectMemory multi-rules", () => {
  it("merges AGENTS.md with .cursor/rules and .kovi/rules", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kovi-mem-"));
    tmpRoots.push(root);
    fs.writeFileSync(path.join(root, "AGENTS.md"), "Base agents rules.", "utf8");
    fs.mkdirSync(path.join(root, ".cursor", "rules"), { recursive: true });
    fs.mkdirSync(path.join(root, ".kovi", "rules"), { recursive: true });
    fs.writeFileSync(path.join(root, ".cursor", "rules", "style.md"), "Use TypeScript.", "utf8");
    fs.writeFileSync(path.join(root, ".kovi", "rules", "security.mdc"), "No secrets.", "utf8");

    const mem = loadProjectMemory(root);
    expect(mem).toMatch(/Base agents rules/);
    expect(mem).toMatch(/Use TypeScript/);
    expect(mem).toMatch(/No secrets/);
    expect(mem).toMatch(/\.cursor\/rules\/style\.md/);
  });

  it("prioritizes AGENTS and stays under 6k", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kovi-mem2-"));
    tmpRoots.push(root);
    fs.writeFileSync(path.join(root, "AGENTS.md"), "A".repeat(5500), "utf8");
    fs.mkdirSync(path.join(root, ".cursor", "rules"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".cursor", "rules", "extra.md"),
      "B".repeat(4000),
      "utf8",
    );
    const mem = loadProjectMemory(root)!;
    expect(mem.length).toBeLessThanOrEqual(6200);
    expect(mem.startsWith("# AGENTS.md")).toBe(true);
  });
});

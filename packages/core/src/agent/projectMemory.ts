import fs from "node:fs";
import path from "node:path";
import { assertAllowedPath } from "../tools/sandbox.js";

const MEMORY_FILES = ["AGENTS.md", "agents.md", "KOVI.md", "kovi.md"];
const RULE_DIRS = [".cursor/rules", ".kovi/rules"];
const MAX_TOTAL = 6_000;

function safeReadFile(projectRoot: string, relOrAbs: string): string | null {
  const full = path.isAbsolute(relOrAbs) ? relOrAbs : path.join(projectRoot, relOrAbs);
  try {
    assertAllowedPath(full, "project", projectRoot, []);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
    return fs.readFileSync(full, "utf8").trim();
  } catch {
    return null;
  }
}

function collectRuleFiles(projectRoot: string): string[] {
  const out: string[] = [];
  for (const dirRel of RULE_DIRS) {
    const dir = path.join(projectRoot, dirRel);
    try {
      assertAllowedPath(dir, "project", projectRoot, []);
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isFile()) continue;
        if (!/\.(md|mdc)$/i.test(ent.name)) continue;
        out.push(path.join(dirRel, ent.name).replace(/\\/g, "/"));
      }
    } catch {
      // skip missing / denied dirs
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/**
 * Load project memory: AGENTS.md (etc.) first, then `.cursor/rules` / `.kovi/rules`.
 * Total budget ≤ 6k chars (AGENTS has priority).
 */
export function loadProjectMemory(projectRoot: string | null): string | null {
  if (!projectRoot) return null;
  const parts: string[] = [];
  let used = 0;

  for (const name of MEMORY_FILES) {
    const text = safeReadFile(projectRoot, name);
    if (!text) continue;
    const slice = text.slice(0, MAX_TOTAL);
    parts.push(`# ${name}\n${slice}`);
    used = slice.length;
    break; // first matching memory file wins (legacy priority)
  }

  const rules = collectRuleFiles(projectRoot);
  for (const rel of rules) {
    if (used >= MAX_TOTAL) break;
    const text = safeReadFile(projectRoot, rel);
    if (!text) continue;
    const room = MAX_TOTAL - used;
    const header = `\n\n# Rule: ${rel}\n`;
    const body = text.slice(0, Math.max(0, room - header.length));
    if (!body) break;
    parts.push(`${header}${body}`);
    used += header.length + body.length;
  }

  const merged = parts.join("").trim();
  return merged || null;
}

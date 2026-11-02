import fs from "node:fs";
import path from "node:path";
import { assertAllowedPath } from "../tools/sandbox.js";

const MEMORY_FILES = ["AGENTS.md", "agents.md", "KOVI.md", "kovi.md"];
const RULE_DIRS = [".cursor/rules", ".kovi/rules"];
/** Soft budget — prefer summarize over hard truncate when rules are large. */
const MAX_TOTAL = 12_000;
const MAX_RULE_BODY = 2_400;
const SUMMARY_LINE = 160;

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

/** Prefer title / first heading / first non-empty lines as a compact rule summary. */
function summarizeRule(text: string, rel: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const heading = lines.find((l) => /^#{1,3}\s+/.test(l));
  const bullets = lines.filter((l) => /^[-*•]/.test(l)).slice(0, 6);
  const bits: string[] = [];
  if (heading) bits.push(heading.replace(/^#{1,3}\s+/, "").slice(0, SUMMARY_LINE));
  else bits.push(rel);
  for (const b of bullets) bits.push(b.slice(0, SUMMARY_LINE));
  if (!bullets.length) {
    for (const l of lines.slice(0, 4)) {
      if (l === heading) continue;
      bits.push(l.slice(0, SUMMARY_LINE));
    }
  }
  return bits.join(" · ").slice(0, MAX_RULE_BODY);
}

/**
 * Load project memory: AGENTS.md first, then `.cursor/rules` / `.kovi/rules`.
 * Large rule sets are summarized instead of hard-cut mid-file.
 */
export function loadProjectMemory(projectRoot: string | null): string | null {
  if (!projectRoot) return null;
  const parts: string[] = [];
  let used = 0;

  for (const name of MEMORY_FILES) {
    const text = safeReadFile(projectRoot, name);
    if (!text) continue;
    const room = Math.min(MAX_TOTAL, Math.floor(MAX_TOTAL * 0.55));
    const slice = text.length > room ? `${text.slice(0, room)}\n…[AGENTS truncated]` : text;
    parts.push(`# ${name}\n${slice}`);
    used = slice.length;
    break;
  }

  const rules = collectRuleFiles(projectRoot);
  const fullBudgetLeft = () => Math.max(0, MAX_TOTAL - used);

  for (const rel of rules) {
    const room = fullBudgetLeft();
    if (room < 80) {
      parts.push(`\n\n# Rules (ещё ${rules.length - rules.indexOf(rel)} файлов опущено — бюджет)`);
      break;
    }
    const text = safeReadFile(projectRoot, rel);
    if (!text) continue;
    const header = `\n\n# Rule: ${rel}\n`;
    let body: string;
    if (text.length + header.length <= Math.min(room, MAX_RULE_BODY + header.length)) {
      body = text.slice(0, room - header.length);
    } else {
      body = summarizeRule(text, rel);
      if (body.length + header.length > room) {
        body = body.slice(0, Math.max(0, room - header.length));
      }
    }
    if (!body) break;
    parts.push(`${header}${body}`);
    used += header.length + body.length;
  }

  const merged = parts.join("").trim();
  return merged || null;
}

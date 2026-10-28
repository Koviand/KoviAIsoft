import fs from "node:fs";
import path from "node:path";

const MEMORY_FILES = ["AGENTS.md", "agents.md", "KOVI.md", "KOVI.md.md"];

/** Load project memory markdown if present under projectRoot. */
export function loadProjectMemory(projectRoot: string | null): string | null {
  if (!projectRoot) return null;
  for (const name of MEMORY_FILES) {
    const full = path.join(projectRoot, name);
    try {
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue;
      const text = fs.readFileSync(full, "utf8").trim();
      if (!text) continue;
      return text.slice(0, 24_000);
    } catch {
      // try next
    }
  }
  return null;
}

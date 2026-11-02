import fs from "node:fs";
import path from "node:path";
import { projectContextCache } from "./projectCache.js";

const IGNORE_DIR = new Set([
  ".git",
  ".kovi",
  "node_modules",
  "dist",
  "build",
  ".next",
  "out",
  "__pycache__",
  ".venv",
  "venv",
]);

function shouldIgnore(relOrName: string): boolean {
  const parts = relOrName.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.some((p) => IGNORE_DIR.has(p) || p.startsWith("."));
}

/**
 * Debounced fs.watch on project root → invalidate @codebase cache.
 * Uses Node recursive watch (supported on Windows).
 */
export class ProjectRootWatcher {
  private watcher: fs.FSWatcher | null = null;
  private root: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  start(projectRoot: string | null | undefined): void {
    const next = projectRoot ? path.resolve(projectRoot) : null;
    if (next === this.root) return;
    this.stop();
    this.root = next;
    if (!next || !fs.existsSync(next)) return;
    try {
      this.watcher = fs.watch(next, { recursive: true }, (_event, filename) => {
        // Windows often emits null filename for noisy events — skip to avoid cache thrash.
        if (!filename) return;
        if (shouldIgnore(String(filename))) return;
        this.scheduleInvalidate(next);
      });
      this.watcher.on("error", () => {
        /* ignore watcher errors (deleted root etc.) */
      });
    } catch {
      this.watcher = null;
    }
  }

  private scheduleInvalidate(root: string): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        projectContextCache.invalidateRoot(root);
      } catch {
        /* ignore */
      }
    }, 400);
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        /* ignore */
      }
      this.watcher = null;
    }
    this.root = null;
  }
}

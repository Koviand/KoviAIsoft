import { buildProjectMap, type ProjectMapOptions, type ProjectMapResult } from "./projectMap.js";
import {
  retrieveProjectContext,
  type RetrieveOptions,
  type RetrievedSnippet,
} from "./retrieve.js";

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 45_000;

/**
 * Short TTL cache for project map / retrieve within an agent run
 * (avoids re-walking the tree on every tool step).
 */
export class ProjectContextCache {
  private mapCache = new Map<string, CacheEntry<ProjectMapResult>>();
  private retrieveCache = new Map<string, CacheEntry<RetrievedSnippet[]>>();
  private ttlMs: number;

  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  clear(): void {
    this.mapCache.clear();
    this.retrieveCache.clear();
  }

  /** Drop entries for one project (after writes / reindex). */
  invalidateRoot(projectRoot: string): void {
    const prefix = `${projectRoot}|`;
    for (const key of [...this.mapCache.keys()]) {
      if (key.startsWith(prefix)) this.mapCache.delete(key);
    }
    for (const key of [...this.retrieveCache.keys()]) {
      if (key.startsWith(prefix)) this.retrieveCache.delete(key);
    }
  }

  getMap(projectRoot: string, opts: ProjectMapOptions = {}): ProjectMapResult {
    const key = `${projectRoot}|${opts.maxEntries ?? 400}|${opts.maxDepth ?? 6}`;
    const hit = this.mapCache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    const value = buildProjectMap(projectRoot, opts);
    this.mapCache.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    return value;
  }

  async getRetrieved(
    projectRoot: string,
    query: string,
    opts: RetrieveOptions = {},
  ): Promise<RetrievedSnippet[]> {
    const key = `${projectRoot}|${query}|${opts.maxFiles ?? 8}|${opts.maxBytesPerFile ?? 4500}|${opts.maxTotalBytes ?? 20_000}|sem=${opts.forceSemantic ? 1 : 0}`;
    const hit = this.retrieveCache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    const value = await retrieveProjectContext(projectRoot, query, opts);
    this.retrieveCache.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    return value;
  }
}

/** Process-wide cache shared by packer + agent mid-run refresh. */
export const projectContextCache = new ProjectContextCache();

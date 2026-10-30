import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ensureDir, getAppDataDir } from "../paths.js";
import {
  CHUNKER_LIMITS,
  chunkSourceText,
  shouldIndexFileBytes,
  type TextChunk,
} from "./chunker.js";
import {
  cosineSimilarity,
  embedTexts,
  getActiveEmbeddingSpec,
  getEmbeddingDim,
} from "./embedder.js";
import { isProbablyBinaryPath, isTextSourcePath, shouldIgnoreDirName } from "./ignore.js";

export interface IndexMeta {
  version: 1;
  root: string;
  modelId: string;
  dim: number;
  chunkCount: number;
  updatedAt: string;
  /** relPath → mtimeMs */
  mtimes: Record<string, number>;
}

export interface IndexedChunk extends TextChunk {
  /** Row index into vectors.bin */
  row: number;
}

export interface CodebaseIndexStatus {
  ready: boolean;
  indexing: boolean;
  root: string | null;
  chunkCount: number;
  modelId: string;
  updatedAt: string | null;
  error: string | null;
}

export interface SemanticHit {
  relPath: string;
  absPath: string;
  score: number;
  excerpt: string;
  startLine: number;
  endLine: number;
  reason: string;
}

type ProgressFn = (msg: string) => void;

const indexJobs = new Map<string, Promise<void>>();
let globalStatus: CodebaseIndexStatus = {
  ready: false,
  indexing: false,
  root: null,
  chunkCount: 0,
  modelId: "",
  updatedAt: null,
  error: null,
};

export function getCodebaseIndexStatus(): CodebaseIndexStatus {
  return { ...globalStatus };
}

function hashRoot(root: string): string {
  return crypto.createHash("sha1").update(normalizeRoot(root)).digest("hex").slice(0, 16);
}

function normalizeRoot(root: string): string {
  return path.resolve(root).replace(/\\/g, "/").toLowerCase();
}

export function indexDirForProject(projectRoot: string): string {
  const inProject = path.join(projectRoot, ".kovi", "codebase-index");
  try {
    ensureDir(path.join(projectRoot, ".kovi"));
    ensureDir(inProject);
    // Prefer project-local index when writable.
    fs.accessSync(inProject, fs.constants.W_OK);
    return inProject;
  } catch {
    const fallback = path.join(getAppDataDir(), "codebase-index", hashRoot(projectRoot));
    ensureDir(fallback);
    return fallback;
  }
}

function metaPath(dir: string): string {
  return path.join(dir, "meta.json");
}
function chunksPath(dir: string): string {
  return path.join(dir, "chunks.jsonl");
}
function vectorsPath(dir: string): string {
  return path.join(dir, "vectors.bin");
}

function readMeta(dir: string): IndexMeta | null {
  try {
    const raw = fs.readFileSync(metaPath(dir), "utf8");
    return JSON.parse(raw) as IndexMeta;
  } catch {
    return null;
  }
}

function writeMeta(dir: string, meta: IndexMeta): void {
  fs.writeFileSync(metaPath(dir), JSON.stringify(meta, null, 2), "utf8");
}

function listProjectFiles(projectRoot: string): Array<{ abs: string; rel: string; mtimeMs: number; size: number }> {
  const out: Array<{ abs: string; rel: string; mtimeMs: number; size: number }> = [];
  const stack = [projectRoot];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name === ".kovi") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!shouldIgnoreDirName(e.name)) stack.push(full);
        continue;
      }
      if (!e.isFile()) continue;
      if (!isTextSourcePath(full) || isProbablyBinaryPath(full)) continue;
      try {
        const st = fs.statSync(full);
        if (!shouldIndexFileBytes(st.size)) continue;
        out.push({
          abs: full,
          rel: path.relative(projectRoot, full).replace(/\\/g, "/"),
          mtimeMs: st.mtimeMs,
          size: st.size,
        });
      } catch {
        // skip
      }
    }
  }
  return out;
}

function loadChunks(dir: string): IndexedChunk[] {
  try {
    const raw = fs.readFileSync(chunksPath(dir), "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    return lines.map((l) => JSON.parse(l) as IndexedChunk);
  } catch {
    return [];
  }
}

function saveChunks(dir: string, chunks: IndexedChunk[]): void {
  const body = chunks.map((c) => JSON.stringify(c)).join("\n") + (chunks.length ? "\n" : "");
  fs.writeFileSync(chunksPath(dir), body, "utf8");
}

function loadVectors(dir: string, count: number, dim: number): Float32Array | null {
  try {
    const buf = fs.readFileSync(vectorsPath(dir));
    const expected = count * dim * 4;
    if (buf.byteLength < expected) return null;
    return new Float32Array(buf.buffer, buf.byteOffset, count * dim);
  } catch {
    return null;
  }
}

function saveVectors(dir: string, vectors: Float32Array[], dim: number): void {
  const buf = Buffer.alloc(vectors.length * dim * 4);
  const view = new Float32Array(buf.buffer, buf.byteOffset, vectors.length * dim);
  for (let i = 0; i < vectors.length; i++) {
    view.set(vectors[i]!, i * dim);
  }
  fs.writeFileSync(vectorsPath(dir), buf);
}

async function rebuildFull(
  projectRoot: string,
  dir: string,
  onProgress?: ProgressFn,
): Promise<void> {
  const files = listProjectFiles(projectRoot);
  const allChunks: TextChunk[] = [];
  for (const f of files) {
    let text: string;
    try {
      text = fs.readFileSync(f.abs, "utf8");
    } catch {
      continue;
    }
    allChunks.push(...chunkSourceText(f.rel, text));
    if (allChunks.length >= CHUNKER_LIMITS.MAX_CHUNKS_PER_PROJECT) break;
  }
  const capped = allChunks.slice(0, CHUNKER_LIMITS.MAX_CHUNKS_PER_PROJECT);
  // Spec after embed — model may have switched during a long job.
  onProgress?.(`Эмбеддинг ${capped.length} чанков…`);
  const vectors = capped.length
    ? await embedTexts(
        capped.map((c) => c.text),
        { role: "document" },
      )
    : [];
  const spec = getActiveEmbeddingSpec();
  if (vectors.length && vectors[0]!.length !== spec.dim) {
    throw new Error(
      `Dim mismatch после embed: ${vectors[0]!.length} ≠ ${spec.dim} (${spec.metaModelId})`,
    );
  }
  const indexed: IndexedChunk[] = capped.map((c, row) => ({ ...c, row }));
  saveChunks(dir, indexed);
  saveVectors(dir, vectors, spec.dim);
  const mtimes: Record<string, number> = {};
  for (const f of files) mtimes[f.rel] = f.mtimeMs;
  writeMeta(dir, {
    version: 1,
    root: projectRoot,
    modelId: spec.metaModelId,
    dim: spec.dim,
    chunkCount: indexed.length,
    updatedAt: new Date().toISOString(),
    mtimes,
  });
}

async function incrementalUpdate(
  projectRoot: string,
  dir: string,
  meta: IndexMeta,
  onProgress?: ProgressFn,
): Promise<void> {
  const files = listProjectFiles(projectRoot);
  const fileMap = new Map(files.map((f) => [f.rel, f]));
  const dim = meta.dim || getEmbeddingDim();
  const oldChunks = loadChunks(dir);
  const oldVec = loadVectors(dir, meta.chunkCount, dim);
  const spec = getActiveEmbeddingSpec();

  if (!oldVec || oldChunks.length !== meta.chunkCount) {
    onProgress?.("Повреждённый индекс — полная пересборка…");
    await rebuildFull(projectRoot, dir, onProgress);
    return;
  }

  const keep: IndexedChunk[] = [];
  const keepVec: Float32Array[] = [];
  const changedRels = new Set<string>();

  for (const f of files) {
    const prev = meta.mtimes[f.rel];
    if (prev == null || Math.abs(prev - f.mtimeMs) > 1) changedRels.add(f.rel);
  }
  for (const rel of Object.keys(meta.mtimes)) {
    if (!fileMap.has(rel)) changedRels.add(rel);
  }

  if (!changedRels.size && oldChunks.length === meta.chunkCount) {
    onProgress?.("Индекс актуален");
    return;
  }

  // Keep unchanged file chunks
  for (const c of oldChunks) {
    if (changedRels.has(c.relPath)) continue;
    if (!oldVec) continue;
    const row = c.row;
    const slice = oldVec.subarray(row * dim, (row + 1) * dim);
    keep.push({ ...c, row: keep.length });
    keepVec.push(new Float32Array(slice));
  }

  // Re-chunk changed existing files
  const newChunks: TextChunk[] = [];
  for (const rel of changedRels) {
    const f = fileMap.get(rel);
    if (!f) continue; // deleted
    let text: string;
    try {
      text = fs.readFileSync(f.abs, "utf8");
    } catch {
      continue;
    }
    newChunks.push(...chunkSourceText(rel, text));
  }

  const room = Math.max(0, CHUNKER_LIMITS.MAX_CHUNKS_PER_PROJECT - keep.length);
  const toAdd = newChunks.slice(0, room);
  onProgress?.(`Переиндексация: +${toAdd.length} чанков…`);
  const newVecs = toAdd.length
    ? await embedTexts(
        toAdd.map((c) => c.text),
        { role: "document" },
      )
    : [];

  const finalChunks: IndexedChunk[] = [
    ...keep,
    ...toAdd.map((c, i) => ({ ...c, row: keep.length + i })),
  ];
  const finalVecs = [...keepVec, ...newVecs];
  saveChunks(dir, finalChunks);
  saveVectors(dir, finalVecs, spec.dim);
  const mtimes: Record<string, number> = {};
  for (const f of files) mtimes[f.rel] = f.mtimeMs;
  writeMeta(dir, {
    version: 1,
    root: projectRoot,
    modelId: spec.metaModelId,
    dim: spec.dim,
    chunkCount: finalChunks.length,
    updatedAt: new Date().toISOString(),
    mtimes,
  });
}

/**
 * Ensure project semantic index exists / is up to date.
 */
export async function ensureProjectIndex(
  projectRoot: string,
  opts?: { force?: boolean; onProgress?: ProgressFn },
): Promise<CodebaseIndexStatus> {
  const root = path.resolve(projectRoot);
  if (!fs.existsSync(root)) {
    globalStatus = {
      ...globalStatus,
      ready: false,
      indexing: false,
      root,
      error: "Папка проекта не найдена",
    };
    return getCodebaseIndexStatus();
  }

  const key = normalizeRoot(root);
  const existing = indexJobs.get(key);
  if (existing) {
    await existing;
    // After wait: if force or meta no longer matches active model — run again.
    const dir = indexDirForProject(root);
    const meta = readMeta(dir);
    const spec = getActiveEmbeddingSpec();
    const needsAgain =
      opts?.force ||
      !meta ||
      meta.modelId !== spec.metaModelId ||
      meta.dim !== spec.dim;
    if (!needsAgain) return getCodebaseIndexStatus();
    // Fall through to a new job (map entry cleared by previous finally).
  }

  const job = (async () => {
    globalStatus = {
      ...globalStatus,
      indexing: true,
      root,
      error: null,
    };
    const dir = indexDirForProject(root);
    try {
      const meta = readMeta(dir);
      const spec = getActiveEmbeddingSpec();
      if (
        opts?.force ||
        !meta ||
        meta.modelId !== spec.metaModelId ||
        meta.dim !== spec.dim ||
        normalizeRoot(meta.root) !== key
      ) {
        opts?.onProgress?.("Полная индексация codebase…");
        await rebuildFull(root, dir, opts?.onProgress);
      } else {
        await incrementalUpdate(root, dir, meta, opts?.onProgress);
      }
      const next = readMeta(dir);
      const active = getActiveEmbeddingSpec();
      globalStatus = {
        ready: true,
        indexing: false,
        root,
        chunkCount: next?.chunkCount || 0,
        modelId: next?.modelId || active.metaModelId,
        updatedAt: next?.updatedAt || null,
        error: null,
      };
    } catch (err) {
      globalStatus = {
        ...globalStatus,
        ready: false,
        indexing: false,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      indexJobs.delete(key);
    }
  })();

  indexJobs.set(key, job);
  await job;
  return getCodebaseIndexStatus();
}

export async function reindexCodebase(
  projectRoot: string,
  onProgress?: ProgressFn,
): Promise<CodebaseIndexStatus> {
  return ensureProjectIndex(projectRoot, { force: true, onProgress });
}

/** Invalidate paths after write — sync reindex those files into the index. */
export async function invalidateIndexPaths(
  projectRoot: string,
  relOrAbsPaths: string[],
): Promise<void> {
  if (!projectRoot || !relOrAbsPaths.length) return;
  const root = path.resolve(projectRoot);
  const dir = indexDirForProject(root);
  const meta = readMeta(dir);
  if (!meta) {
    // Lazy: schedule soft ensure without blocking forever
    void ensureProjectIndex(root);
    return;
  }
  // Touch mtimes map to force incremental on next ensure; also do quick incremental now.
  for (const p of relOrAbsPaths) {
    const rel = path.isAbsolute(p)
      ? path.relative(root, p).replace(/\\/g, "/")
      : p.replace(/\\/g, "/");
    meta.mtimes[rel] = 0; // force change detection
  }
  writeMeta(dir, meta);
  await ensureProjectIndex(root);
}

export async function semanticSearch(
  projectRoot: string,
  query: string,
  k = 8,
): Promise<SemanticHit[]> {
  const root = path.resolve(projectRoot);
  await ensureProjectIndex(root);
  const dir = indexDirForProject(root);
  const meta = readMeta(dir);
  if (!meta || meta.chunkCount === 0) return [];
  const dim = meta.dim || getEmbeddingDim();
  const chunks = loadChunks(dir);
  const vectors = loadVectors(dir, meta.chunkCount, dim);
  if (!vectors || !chunks.length) return [];

  const [qVec] = await embedTexts([query], { role: "query" });
  if (!qVec) return [];

  const scored: Array<{ chunk: IndexedChunk; score: number }> = [];
  for (const c of chunks) {
    const row = c.row;
    if (row < 0 || row >= meta.chunkCount) continue;
    const slice = vectors.subarray(row * dim, (row + 1) * dim);
    const score = cosineSimilarity(qVec, slice);
    scored.push({ chunk: c, score });
  }
  scored.sort((a, b) => b.score - a.score);

  // Dedup by file: keep best + optionally second chunk if high score
  const byFile = new Map<string, Array<{ chunk: IndexedChunk; score: number }>>();
  for (const s of scored) {
    const list = byFile.get(s.chunk.relPath) || [];
    if (list.length >= 2) continue;
    list.push(s);
    byFile.set(s.chunk.relPath, list);
  }
  const flat = [...byFile.values()].flat().sort((a, b) => b.score - a.score).slice(0, k);

  return flat.map(({ chunk, score }) => ({
    relPath: chunk.relPath,
    absPath: path.join(root, chunk.relPath),
    score,
    excerpt: chunk.text.slice(0, 3500),
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    reason: `semantic ${(score * 100).toFixed(0)}%`,
  }));
}

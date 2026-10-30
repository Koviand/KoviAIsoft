import fs from "node:fs";
import path from "node:path";
import type { EmbeddingModelId, EmbeddingModelInfo, EmbeddingStatus } from "@kovi/shared";
import {
  applyEmbeddingPrefix,
  embeddingsRootDir,
  findLfmGgufPath,
  getEmbeddingSpec,
  isMinilmInstalled,
  listEmbeddingModels,
  lfm25ModelDir,
  LFM25_HF_ID,
  minilmCacheDir,
  MINILM_HF_ID,
  pickLfmGgufFilename,
} from "./embeddingCatalog.js";
import {
  configureEmbeddingServer,
  getSharedEmbeddingServer,
  stopSharedEmbeddingServer,
} from "./embeddingServer.js";
import { downloadHfFile, listHfGgufFiles } from "../models/huggingface.js";
import { ensureDir, getAppDataDir } from "../paths.js";

/** @deprecated Prefer getEmbeddingDim() / getActiveEmbeddingSpec(). */
export const EMBED_MODEL_ID = MINILM_HF_ID;
/** @deprecated Prefer getEmbeddingDim(). */
export const EMBED_DIM = 384;

export type EmbedRole = "query" | "document";
export type EmbedFn = (texts: string[]) => Promise<Float32Array[]>;

export type EmbeddingRuntimeConfig = {
  modelId: EmbeddingModelId;
  appData: string;
  getServerPath: () => string | null;
  getHfToken?: () => string | undefined;
  getDownloadMethod?: () => "auto" | "cli" | "http";
  onProgress?: (progress: number, label: string) => void;
};

let runtimeConfig: EmbeddingRuntimeConfig = {
  modelId: "minilm",
  appData: getAppDataDir(),
  getServerPath: () => null,
};

let pipelinePromise: Promise<EmbedFn> | null = null;
let overrideEmbed: EmbedFn | null = null;
let lastEmbedError: string | null = null;

function allowHashEmbed(): boolean {
  return Boolean(process.env.VITEST || process.env.KOVI_EMBED_HASH === "1");
}

/** Wire settings + llama path from AppService. */
export function setEmbeddingRuntimeConfig(cfg: EmbeddingRuntimeConfig): void {
  const prevId = runtimeConfig.modelId;
  runtimeConfig = cfg;
  configureEmbeddingServer({
    getServerPath: cfg.getServerPath,
    appData: cfg.appData,
    getGgufPath: () => findLfmGgufPath(cfg.appData),
  });
  if (prevId !== cfg.modelId) {
    pipelinePromise = null;
    lastEmbedError = null;
  }
}

export function getEmbeddingRuntimeConfig(): EmbeddingRuntimeConfig {
  return runtimeConfig;
}

export function getActiveEmbeddingSpec() {
  return getEmbeddingSpec(runtimeConfig.modelId);
}

export function getEmbeddingDim(): number {
  return getActiveEmbeddingSpec().dim;
}

export function getActiveEmbeddingModelId(): EmbeddingModelId {
  return runtimeConfig.modelId;
}

export function getLastEmbedError(): string | null {
  return lastEmbedError;
}

/** Test hook — inject fake embeddings (no model download). */
export function setEmbedderOverride(fn: EmbedFn | null): void {
  overrideEmbed = fn;
  pipelinePromise = null;
  lastEmbedError = null;
}

export async function resetEmbedder(): Promise<void> {
  pipelinePromise = null;
  lastEmbedError = null;
  await stopSharedEmbeddingServer();
}

/** Deterministic bag-of-chars fallback when transformers unavailable (dev/tests). */
export function hashEmbed(text: string, dim = getEmbeddingDim()): Float32Array {
  const v = new Float32Array(dim);
  const s = text.toLowerCase();
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    const idx = (code * 131 + i * 17) % dim;
    v[idx] += 1;
    v[(idx + code) % dim] += 0.35;
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += v[i]! * v[i]!;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) v[i]! /= norm;
  return v;
}

function assertDim(arr: Float32Array, dim: number, label: string): Float32Array {
  if (arr.length === dim) return arr;
  throw new Error(
    `${label}: ожидалась dim=${dim}, получено ${arr.length} — переиндексируйте @codebase`,
  );
}

async function loadTransformersPipeline(): Promise<EmbedFn> {
  const transformers = await import("@huggingface/transformers");
  const { pipeline, env } = transformers as {
    pipeline: (
      task: string,
      model: string,
      opts?: Record<string, unknown>,
    ) => Promise<(input: string | string[], opts?: Record<string, unknown>) => Promise<unknown>>;
    env: { cacheDir?: string; allowLocalModels?: boolean };
  };
  const cacheDir = minilmCacheDir(runtimeConfig.appData);
  ensureDir(cacheDir);
  env.cacheDir = cacheDir;
  env.allowLocalModels = true;

  const dim = getEmbeddingSpec("minilm").dim;
  const extractor = await pipeline("feature-extraction", MINILM_HF_ID, {
    dtype: "fp32",
  });

  return async (texts: string[]) => {
    const out: Float32Array[] = [];
    for (const t of texts) {
      const result = (await extractor(t, {
        pooling: "mean",
        normalize: true,
      })) as { data?: Float32Array | number[]; tolist?: () => number[][] };
      let arr: Float32Array;
      if (result?.data) {
        const d = result.data;
        arr = d instanceof Float32Array ? d : Float32Array.from(d);
      } else if (typeof result?.tolist === "function") {
        const list = result.tolist();
        const flat = Array.isArray(list[0]) ? list[0]! : (list as unknown as number[]);
        arr = Float32Array.from(flat);
      } else {
        throw new Error("MiniLM: пустой ответ feature-extraction");
      }
      out.push(assertDim(arr, dim, "MiniLM"));
    }
    return out;
  };
}

async function embedWithMinilm(texts: string[]): Promise<Float32Array[]> {
  if (allowHashEmbed()) {
    const dim = getEmbeddingSpec("minilm").dim;
    return texts.map((t) => hashEmbed(t, dim));
  }
  if (!pipelinePromise) {
    pipelinePromise = loadTransformersPipeline().catch((err) => {
      pipelinePromise = null;
      lastEmbedError = err instanceof Error ? err.message : String(err);
      throw err;
    });
  }
  try {
    const fn = await pipelinePromise;
    lastEmbedError = null;
    return await fn(texts);
  } catch (err) {
    lastEmbedError = err instanceof Error ? err.message : String(err);
    throw err;
  }
}

async function embedWithLfm(
  texts: string[],
  role: EmbedRole,
): Promise<Float32Array[]> {
  if (allowHashEmbed()) {
    const dim = getEmbeddingSpec("lfm25").dim;
    const spec = getEmbeddingSpec("lfm25");
    return texts.map((t) =>
      hashEmbed(applyEmbeddingPrefix(t, role, spec.usesPrefixes), dim),
    );
  }
  const spec = getEmbeddingSpec("lfm25");
  const prefixed = texts.map((t) => applyEmbeddingPrefix(t, role, spec.usesPrefixes));
  try {
    const server = getSharedEmbeddingServer();
    const vectors = await server.embed(prefixed);
    lastEmbedError = null;
    return vectors.map((arr) => assertDim(arr, spec.dim, "LFM2.5"));
  } catch (err) {
    lastEmbedError = err instanceof Error ? err.message : String(err);
    throw err;
  }
}

export async function embedTexts(
  texts: string[],
  opts?: { role?: EmbedRole },
): Promise<Float32Array[]> {
  if (!texts.length) return [];
  const role: EmbedRole = opts?.role ?? "document";
  if (overrideEmbed) {
    return overrideEmbed(texts);
  }
  const id = runtimeConfig.modelId;
  if (id === "lfm25") {
    return embedWithLfm(texts, role);
  }
  return embedWithMinilm(texts);
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const den = Math.sqrt(na) * Math.sqrt(nb);
  return den ? dot / den : 0;
}

export function ensureEmbeddingCacheWritable(): boolean {
  try {
    const dir = embeddingsRootDir(runtimeConfig.appData);
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function getEmbeddingStatus(): EmbeddingStatus {
  const models = listEmbeddingModels({
    appData: runtimeConfig.appData,
    llamaServerPath: runtimeConfig.getServerPath(),
  }).map((m) => {
    if (m.id === runtimeConfig.modelId && lastEmbedError) {
      return { ...m, ready: false, error: lastEmbedError };
    }
    return m;
  });
  return {
    activeId: runtimeConfig.modelId,
    models,
  };
}

export function listEmbeddingModelsInfo(): EmbeddingModelInfo[] {
  return getEmbeddingStatus().models;
}

export async function downloadEmbeddingModel(
  id: EmbeddingModelId,
): Promise<EmbeddingModelInfo> {
  const onProgress = runtimeConfig.onProgress;
  if (id === "minilm") {
    onProgress?.(5, "Скачивание MiniLM…");
    pipelinePromise = null;
    lastEmbedError = null;
    if (allowHashEmbed()) {
      const dir = minilmCacheDir(runtimeConfig.appData);
      const modelDir = path.join(dir, "Xenova", "all-MiniLM-L6-v2");
      ensureDir(modelDir);
      fs.writeFileSync(
        path.join(modelDir, "config.json"),
        JSON.stringify({ model_type: "bert", stub: true }),
        "utf8",
      );
      // Marker so installed check (onnx required) passes in hash-test mode.
      fs.writeFileSync(path.join(modelDir, "model.onnx"), Buffer.from([0]), "binary");
    } else {
      const fn = await loadTransformersPipeline();
      pipelinePromise = Promise.resolve(fn);
    }
    onProgress?.(100, "MiniLM готов");
  } else {
    onProgress?.(5, "Скачивание LFM2.5 Embedding GGUF…");
    const dest = lfm25ModelDir(runtimeConfig.appData);
    ensureDir(dest);
    const files = await listHfGgufFiles(LFM25_HF_ID);
    const filePath = pickLfmGgufFilename(files.map((f) => f.path));
    await downloadHfFile(LFM25_HF_ID, filePath, dest, {
      method: runtimeConfig.getDownloadMethod?.() ?? "auto",
      token: runtimeConfig.getHfToken?.(),
      onProgress: (p, label) => onProgress?.(p, label || "LFM2.5…"),
    });
    onProgress?.(100, "LFM2.5 Embedding готов");
  }
  return listEmbeddingModels({
    appData: runtimeConfig.appData,
    llamaServerPath: runtimeConfig.getServerPath(),
  }).find((m) => m.id === id)!;
}

export { isMinilmInstalled, findLfmGgufPath, applyEmbeddingPrefix, pickLfmGgufFilename };

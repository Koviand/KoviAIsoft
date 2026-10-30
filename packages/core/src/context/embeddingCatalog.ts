import fs from "node:fs";
import path from "node:path";
import type { EmbeddingModelId, EmbeddingModelInfo } from "@kovi/shared";
import { ensureDir, getAppDataDir } from "../paths.js";

export const MINILM_HF_ID = "Xenova/all-MiniLM-L6-v2";
export const LFM25_HF_ID = "LiquidAI/LFM2.5-Embedding-350M-GGUF";

export interface EmbeddingSpec {
  id: EmbeddingModelId;
  label: string;
  dim: number;
  backend: "transformers" | "llama-embeddings";
  hfId: string;
  sizeHint: string;
  /** Stored in index meta.json */
  metaModelId: string;
  usesPrefixes: boolean;
}

export const EMBEDDING_SPECS: Record<EmbeddingModelId, EmbeddingSpec> = {
  minilm: {
    id: "minilm",
    label: "all-MiniLM-L6-v2",
    dim: 384,
    backend: "transformers",
    hfId: MINILM_HF_ID,
    sizeHint: "~90 MB · CPU · dim 384",
    metaModelId: `minilm:${MINILM_HF_ID}`,
    usesPrefixes: false,
  },
  lfm25: {
    id: "lfm25",
    label: "LFM2.5-Embedding-350M",
    dim: 1024,
    backend: "llama-embeddings",
    hfId: LFM25_HF_ID,
    sizeHint: "~350–400 MB GGUF · CPU · dim 1024",
    metaModelId: `lfm25:${LFM25_HF_ID}`,
    usesPrefixes: true,
  },
};

export function getEmbeddingSpec(id: EmbeddingModelId): EmbeddingSpec {
  return EMBEDDING_SPECS[id];
}

export function embeddingsRootDir(appData = getAppDataDir()): string {
  const dir = path.join(appData, "models", "embeddings");
  ensureDir(dir);
  return dir;
}

export function minilmCacheDir(appData = getAppDataDir()): string {
  const dir = path.join(embeddingsRootDir(appData), "minilm");
  ensureDir(dir);
  return dir;
}

export function lfm25ModelDir(appData = getAppDataDir()): string {
  const dir = path.join(embeddingsRootDir(appData), "lfm25");
  ensureDir(dir);
  return dir;
}

/** Prefer Q8_0, else any Q4*, else first .gguf. */
export function pickLfmGgufFilename(names: string[]): string {
  const ggufs = names.filter((n) => n.toLowerCase().endsWith(".gguf"));
  if (!ggufs.length) {
    throw new Error("В репозитории LFM2.5 нет GGUF файлов");
  }
  const q8 = ggufs.find((n) => /Q8_0/i.test(n));
  if (q8) return q8;
  const q4 = ggufs.find((n) => /Q4/i.test(n));
  if (q4) return q4;
  return ggufs[0]!;
}

function dirHasOnnx(dir: string): boolean {
  if (!fs.existsSync(dir)) return false;
  try {
    const stack = [dir];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const name of fs.readdirSync(cur)) {
        const full = path.join(cur, name);
        let st: fs.Stats;
        try {
          st = fs.statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (name.toLowerCase().endsWith(".onnx")) return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

export function isMinilmInstalled(appData = getAppDataDir()): boolean {
  const root = embeddingsRootDir(appData);
  const candidates = [
    minilmCacheDir(appData),
    path.join(root, "Xenova", "all-MiniLM-L6-v2"),
    path.join(root, "models", "Xenova", "all-MiniLM-L6-v2"),
  ];
  // Require real ONNX weights — config.json alone used to fake "installed".
  return candidates.some(dirHasOnnx);
}

export function findLfmGgufPath(appData = getAppDataDir()): string | null {
  const dir = lfm25ModelDir(appData);
  try {
    const names = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".gguf"));
    if (!names.length) return null;
    const pick = pickLfmGgufFilename(names);
    const full = path.join(dir, pick);
    return fs.existsSync(full) ? full : path.join(dir, names[0]!);
  } catch {
    return null;
  }
}

export function isLfm25Installed(appData = getAppDataDir()): boolean {
  return Boolean(findLfmGgufPath(appData));
}

export function buildEmbeddingModelInfo(
  id: EmbeddingModelId,
  opts: { appData?: string; llamaServerPath?: string | null },
): EmbeddingModelInfo {
  const appData = opts.appData ?? getAppDataDir();
  const spec = getEmbeddingSpec(id);
  let installed = false;
  let ready = false;
  let error: string | null = null;

  if (id === "minilm") {
    installed = isMinilmInstalled(appData);
    ready = installed;
  } else {
    installed = isLfm25Installed(appData);
    const server = opts.llamaServerPath;
    if (!installed) {
      ready = false;
    } else if (!server || !fs.existsSync(server)) {
      ready = false;
      error = "Нужен установленный llama-server (runtime)";
    } else {
      ready = true;
    }
  }

  return {
    id: spec.id,
    label: spec.label,
    dim: spec.dim,
    backend: spec.backend,
    installed,
    ready,
    sizeHint: spec.sizeHint,
    error,
    hfId: spec.hfId,
  };
}

export function listEmbeddingModels(opts: {
  appData?: string;
  llamaServerPath?: string | null;
}): EmbeddingModelInfo[] {
  return (Object.keys(EMBEDDING_SPECS) as EmbeddingModelId[]).map((id) =>
    buildEmbeddingModelInfo(id, opts),
  );
}

/** Apply LFM query/document instruction prefixes. */
export function applyEmbeddingPrefix(
  text: string,
  role: "query" | "document",
  usesPrefixes: boolean,
): string {
  if (!usesPrefixes) return text;
  const prefix = role === "query" ? "query: " : "document: ";
  const stripped = text.replace(/^(query|document):\s*/i, "");
  return prefix + stripped;
}

import fs from "node:fs";
import path from "node:path";
import type { HfFile, HfSearchResult, ModelPerfTier } from "@kovi/shared";
import { downloadFile, type ProgressFn } from "../runtime/download.js";
import { ensureDir } from "../paths.js";
import {
  classifyPerfTier,
  detectQuantLabel,
  recommendQuantFiles,
} from "./scanner.js";

const HF_API = "https://huggingface.co/api";

export async function searchHfModels(query: string): Promise<HfSearchResult[]> {
  const url = new URL(`${HF_API}/models`);
  url.searchParams.set("search", query);
  url.searchParams.set("filter", "gguf");
  url.searchParams.set("sort", "downloads");
  url.searchParams.set("limit", "30");
  const res = await fetch(url, { headers: { "User-Agent": "KoviAIsoft" } });
  if (!res.ok) throw new Error(`HF search failed: ${res.status}`);
  const data = (await res.json()) as Array<{
    id: string;
    modelId?: string;
    downloads?: number;
    likes?: number;
    tags?: string[];
    lastModified?: string;
  }>;
  return data.map((m) => ({
    id: m.id,
    modelId: m.modelId || m.id,
    downloads: m.downloads || 0,
    likes: m.likes || 0,
    tags: m.tags || [],
    lastModified: m.lastModified,
  }));
}

async function fetchGgufSiblings(
  modelId: string,
): Promise<Array<{ path: string; size: number }>> {
  const res = await fetch(`${HF_API}/models/${encodeURIComponent(modelId)}`, {
    headers: { "User-Agent": "KoviAIsoft" },
  });
  if (!res.ok) return [];
  const data = (await res.json()) as {
    siblings?: Array<{ rfilename: string; size?: number }>;
  };
  return (data.siblings || [])
    .filter(
      (s) =>
        s.rfilename.toLowerCase().endsWith(".gguf") && !/mmproj/i.test(s.rfilename),
    )
    .map((s) => ({ path: s.rfilename, size: s.size || 0 }));
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  }
  const n = Math.min(concurrency, Math.max(1, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

/** Attach hardware fit tier using HF siblings (best recommended quant). */
export async function enrichHfSearchWithFit(
  results: HfSearchResult[],
  vramGb: number | null | undefined,
  ramGb: number,
): Promise<HfSearchResult[]> {
  return mapPool(results, 6, async (r) => {
    try {
      const siblings = await fetchGgufSiblings(r.id);
      if (siblings.length === 0) return r;
      const ranked = recommendQuantFiles(siblings, vramGb ?? undefined, ramGb);
      const bestPath = ranked[0] || siblings.sort((a, b) => a.size - b.size)[0]?.path;
      const best = siblings.find((s) => s.path === bestPath) || siblings[0];
      if (!best || best.size <= 0) return r;
      const tier: ModelPerfTier = classifyPerfTier(best.size, vramGb, ramGb);
      return {
        ...r,
        tier,
        approxSizeBytes: best.size,
        suggestedQuant: detectQuantLabel(best.path),
      };
    } catch {
      return r;
    }
  });
}

export function annotateHfFilesWithFit(
  files: HfFile[],
  vramGb: number | null | undefined,
  ramGb: number,
): HfFile[] {
  return files.map((f) => {
    if (!f.isGguf || f.size <= 0 || /mmproj/i.test(f.path)) return f;
    return { ...f, tier: classifyPerfTier(f.size, vramGb, ramGb) };
  });
}

export async function listHfGgufFiles(modelId: string): Promise<HfFile[]> {
  const res = await fetch(`${HF_API}/models/${modelId}/tree/main`, {
    headers: { "User-Agent": "KoviAIsoft" },
  });
  if (!res.ok) throw new Error(`HF tree failed: ${res.status}`);
  const data = (await res.json()) as Array<{ path: string; size?: number; type?: string }>;
  const files: HfFile[] = [];
  for (const item of data) {
    if (item.type && item.type !== "file") continue;
    const isGguf = item.path.toLowerCase().endsWith(".gguf");
    if (!isGguf && !/mmproj/i.test(item.path)) continue;
    files.push({
      path: item.path,
      size: item.size || 0,
      isGguf,
    });
  }

  // Also flatten nested via recursive? HF tree/main is often flat enough for GGUF repos.
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export function recommendHfFiles(
  files: HfFile[],
  vramGb?: number,
  ramGb?: number,
): HfFile[] {
  const paths = recommendQuantFiles(
    files.map((f) => ({ path: f.path, size: f.size })),
    vramGb,
    ramGb,
  );
  return files.filter((f) => paths.includes(f.path));
}

export type DownloadHfOptions = {
  method?: "auto" | "cli" | "http";
  token?: string;
  onProgress?: ProgressFn;
};

export async function downloadHfFile(
  modelId: string,
  filePath: string,
  destDir: string,
  onProgressOrOpts?: ProgressFn | DownloadHfOptions,
): Promise<{ path: string; via: "cli" | "http" }> {
  const opts: DownloadHfOptions =
    typeof onProgressOrOpts === "function"
      ? { onProgress: onProgressOrOpts, method: "auto" }
      : onProgressOrOpts || { method: "auto" };
  const method: "auto" | "cli" | "http" = opts.method || "auto";
  const onProgress = opts.onProgress;
  const cliOnly = method === "cli";

  const { downloadViaHfCli, resolveHfCli, ensureHfCli } = await import("./hfCli.js");

  // Prefer CLI: ensure bundled toolchain when missing (auto/cli).
  if (method !== "http" && !resolveHfCli()) {
    try {
      onProgress?.(2, "Установка встроенного HF CLI…");
      await ensureHfCli(onProgress);
    } catch (err) {
      if (cliOnly) throw err;
      onProgress?.(
        5,
        `HF CLI не установился — HTTP (${err instanceof Error ? err.message.slice(0, 80) : "error"})`,
      );
    }
  }

  const tryCli = cliOnly || (method === "auto" && Boolean(resolveHfCli()));
  if (tryCli) {
    try {
      const dest = await downloadViaHfCli(modelId, filePath, destDir, {
        token: opts.token,
        onProgress,
      });
      return { path: dest, via: "cli" };
    } catch (err) {
      if (cliOnly) throw err;
      onProgress?.(5, "HF CLI ошибка — HTTP…");
    }
  }

  if (cliOnly) {
    throw new Error("Режим скачивания: только HF CLI, но CLI не найден.");
  }

  ensureDir(destDir);
  const modelDir = path.join(destDir, modelId.replace(/[\\/]/g, "__"));
  ensureDir(modelDir);
  const dest = path.join(modelDir, path.basename(filePath));
  const url = `https://huggingface.co/${modelId}/resolve/main/${filePath}`;
  // Token is primarily for HF CLI gated repos; HTTP path uses public resolve URL.
  await downloadFile(url, dest, onProgress);
  return { path: dest, via: "http" };
}

export function ensureLocalFile(filePath: string): void {
  if (!fs.existsSync(filePath)) throw new Error(`Файл не найден: ${filePath}`);
}

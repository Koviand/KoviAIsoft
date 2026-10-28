import fs from "node:fs";
import path from "node:path";
import type { HfFile, HfSearchResult } from "@kovi/shared";
import { downloadFile, type ProgressFn } from "../runtime/download.js";
import { ensureDir } from "../paths.js";
import { recommendQuantFiles } from "./scanner.js";

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

export async function downloadHfFile(
  modelId: string,
  filePath: string,
  destDir: string,
  onProgress?: ProgressFn,
): Promise<string> {
  ensureDir(destDir);
  const modelDir = path.join(destDir, modelId.replace(/[\\/]/g, "__"));
  ensureDir(modelDir);
  const dest = path.join(modelDir, path.basename(filePath));
  const url = `https://huggingface.co/${modelId}/resolve/main/${filePath}`;
  await downloadFile(url, dest, onProgress);
  return dest;
}

export function ensureLocalFile(filePath: string): void {
  if (!fs.existsSync(filePath)) throw new Error(`Файл не найден: ${filePath}`);
}

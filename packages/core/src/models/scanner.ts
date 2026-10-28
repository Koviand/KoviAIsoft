import fs from "node:fs";
import path from "node:path";
import type { LocalModel, SystemInfo } from "@kovi/shared";
import { createHash } from "node:crypto";
import { withIntegrity } from "./integrity.js";

const QUANT_RE =
  /(Q[2-8](?:_[A-Z0-9_]+)?|IQ[1-4](?:_[A-Z0-9_]+)?|BF16|F16|F32|FP16|FP32)/i;

function modelIdFor(filePath: string): string {
  return createHash("sha1").update(filePath.toLowerCase()).digest("hex").slice(0, 16);
}

function detectQuant(name: string): string | undefined {
  const m = name.match(QUANT_RE);
  return m?.[1]?.toUpperCase();
}

function findMmproj(dir: string, baseName: string): string | undefined {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return undefined;
  }
  const mmprojs = entries.filter((e) => /mmproj/i.test(e) && e.toLowerCase().endsWith(".gguf"));
  if (mmprojs.length === 0) return undefined;
  const related = mmprojs.find((m) =>
    baseName.toLowerCase().includes(m.replace(/mmproj|\.gguf/gi, "").toLowerCase().slice(0, 8)),
  );
  return path.join(dir, related || mmprojs[0]);
}

function estimateFit(
  sizeBytes: number,
  context: number,
  sys?: SystemInfo,
): { recommendedNgl: number; recommendedContext: number; fitsInVram?: boolean } {
  const sizeGb = sizeBytes / 1024 ** 3;
  const vram = sys?.gpus.find((g) => g.vramGb)?.vramGb;
  let recommendedContext = 8192;
  if (vram && vram < 8) recommendedContext = 4096;
  if (vram && vram >= 16) recommendedContext = 16384;
  if (context) recommendedContext = Math.min(recommendedContext, context);

  if (!vram) {
    return { recommendedNgl: 0, recommendedContext, fitsInVram: undefined };
  }
  // rough KV overhead ~ context * 0.0002 GB for mid models
  const kv = recommendedContext * 0.00025;
  const fits = sizeGb + kv < vram * 0.9;
  return {
    recommendedNgl: fits ? 99 : Math.max(0, Math.floor((vram / (sizeGb + kv)) * 99)),
    recommendedContext,
    fitsInVram: fits,
  };
}

function walkGguf(root: string, out: string[], depth = 0): void {
  if (depth > 6) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === ".cache" || e.name === "node_modules" || e.name.startsWith(".")) continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      walkGguf(full, out, depth + 1);
    } else if (e.isFile() && e.name.toLowerCase().endsWith(".gguf") && !/mmproj/i.test(e.name)) {
      out.push(full);
    }
  }
}

export function scanLocalModels(roots: string[], sys?: SystemInfo): LocalModel[] {
  const files: string[] = [];
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    walkGguf(root, files);
  }

  const models: LocalModel[] = [];
  for (const filePath of files) {
    const st = fs.statSync(filePath);
    const name = path.basename(filePath);
    const dir = path.dirname(filePath);
    const quant = detectQuant(name);
    const est = estimateFit(st.size, 8192, sys);
    models.push(
      withIntegrity({
        id: modelIdFor(filePath),
        name: name.replace(/\.gguf$/i, ""),
        path: filePath,
        sizeBytes: st.size,
        quant,
        mmprojPath: findMmproj(dir, name),
        directory: dir,
        recommendedNgl: est.recommendedNgl,
        recommendedContext: est.recommendedContext,
        fitsInVram: est.fitsInVram,
      }),
    );
  }

  return models.sort((a, b) => a.name.localeCompare(b.name));
}

export function recommendQuantFiles(
  files: { path: string; size: number }[],
  vramGb?: number,
  ramGb?: number,
): string[] {
  const budget = (vramGb ?? 0) > 0 ? vramGb! * 0.85 : (ramGb ?? 16) * 0.5;
  const scored = files
    .filter((f) => f.path.toLowerCase().endsWith(".gguf") && !/mmproj/i.test(f.path))
    .map((f) => {
      const gb = f.size / 1024 ** 3;
      const quant = detectQuant(f.path) || "";
      const quality =
        /Q6|Q8|F16|BF16/i.test(quant) ? 3 : /Q5|Q4/i.test(quant) ? 2 : /Q3|Q2|IQ/i.test(quant) ? 1 : 0;
      const fits = gb <= budget ? 1 : 0;
      return { path: f.path, score: fits * 10 + quality - Math.abs(gb - budget) * 0.1 };
    })
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, 5).map((s) => s.path);
}

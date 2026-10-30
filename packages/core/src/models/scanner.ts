import fs from "node:fs";
import path from "node:path";
import type { LocalModel, ModelPerfTier, SystemInfo } from "@kovi/shared";
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

function isReparseOrLink(full: string, ent: fs.Dirent): boolean {
  if (ent.isSymbolicLink()) return true;
  try {
    const st = fs.lstatSync(full);
    if (st.isSymbolicLink()) return true;
    const attrs = (st as fs.Stats & { fileAttributes?: number }).fileAttributes;
    // Windows FILE_ATTRIBUTE_REPARSE_POINT = 0x400
    if (typeof attrs === "number" && (attrs & 0x400) !== 0) return true;
  } catch {
    return true;
  }
  return false;
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
    // Do not follow junctions/symlinks — they can escape modelRoots.
    if (isReparseOrLink(full, e)) continue;
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

/** Green/yellow/red fit class for a GGUF size on this PC. */
export function classifyPerfTier(
  sizeBytes: number,
  vramGb: number | null | undefined,
  ramGb: number,
): ModelPerfTier {
  const sizeGb = sizeBytes / 1024 ** 3;
  let context = 8192;
  if (vramGb && vramGb < 8) context = 4096;
  if (vramGb && vramGb >= 16) context = 16384;
  const kv = context * 0.00025;
  if (vramGb && vramGb > 0) {
    const need = sizeGb + kv;
    const fits = need < vramGb * 0.9;
    if (fits && sizeGb < vramGb * 0.55) return "excellent";
    if (fits) return "good";
    const ngl = Math.max(0, Math.floor((vramGb / need) * 99));
    if (ngl >= 24) return "tight";
  }
  if (sizeGb < Math.max(1, ramGb) * 0.55) return "cpu";
  return "too_heavy";
}

export function detectQuantLabel(name: string): string | undefined {
  return detectQuant(name);
}

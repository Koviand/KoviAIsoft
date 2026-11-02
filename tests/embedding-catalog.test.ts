import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findLfmGgufPath,
  isLfm25Installed,
  lfm25ModelDir,
} from "../packages/core/src/context/embeddingCatalog";

describe("findLfmGgufPath", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    dirs.length = 0;
  });

  it("finds GGUF nested under LiquidAI__… (HF download layout)", () => {
    const appData = fs.mkdtempSync(path.join(os.tmpdir(), "kovi-emb-"));
    dirs.push(appData);
    const nested = path.join(
      lfm25ModelDir(appData),
      "LiquidAI__LFM2.5-Embedding-350M-GGUF",
    );
    fs.mkdirSync(nested, { recursive: true });
    const gguf = path.join(nested, "LFM2.5-Embedding-350M-Q8_0.gguf");
    fs.writeFileSync(gguf, Buffer.from([1, 2, 3]));
    expect(isLfm25Installed(appData)).toBe(true);
    expect(findLfmGgufPath(appData)).toBe(gguf);
  });

  it("prefers flat Q8_0 in lfm25 root", () => {
    const appData = fs.mkdtempSync(path.join(os.tmpdir(), "kovi-emb-"));
    dirs.push(appData);
    const root = lfm25ModelDir(appData);
    const q4 = path.join(root, "model-Q4_K_M.gguf");
    const q8 = path.join(root, "model-Q8_0.gguf");
    fs.writeFileSync(q4, Buffer.from([1]));
    fs.writeFileSync(q8, Buffer.from([1]));
    expect(findLfmGgufPath(appData)).toBe(q8);
  });
});

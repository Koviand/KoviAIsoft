import { describe, expect, it } from "vitest";
import { recommendQuantFiles } from "../packages/core/src/models/scanner";

describe("recommendQuantFiles", () => {
  it("prefers fitting higher quality quants", () => {
    const files = [
      { path: "model-Q2_K.gguf", size: 2 * 1024 ** 3 },
      { path: "model-Q5_K_M.gguf", size: 5 * 1024 ** 3 },
      { path: "model-Q8_0.gguf", size: 9 * 1024 ** 3 },
      { path: "mmproj-F16.gguf", size: 1 * 1024 ** 3 },
    ];
    const rec = recommendQuantFiles(files, 8, 32);
    expect(rec[0]).toContain("Q5");
    expect(rec.every((p) => !/mmproj/i.test(p))).toBe(true);
  });
});

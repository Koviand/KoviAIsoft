import { describe, expect, it } from "vitest";
import { classifyPerfTier, recommendQuantFiles } from "../packages/core/src/models/scanner";

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

describe("classifyPerfTier", () => {
  const gb = (n: number) => n * 1024 ** 3;

  it("marks small models green on mid VRAM", () => {
    expect(classifyPerfTier(gb(3), 8, 32)).toBe("excellent");
    expect(classifyPerfTier(gb(5), 8, 32)).toBe("good");
  });

  it("marks partial offload yellow and oversized red", () => {
    expect(classifyPerfTier(gb(12), 8, 32)).toBe("tight");
    expect(classifyPerfTier(gb(40), 8, 16)).toBe("too_heavy");
  });

  it("falls back to CPU when no VRAM but RAM enough", () => {
    expect(classifyPerfTier(gb(4), null, 16)).toBe("cpu");
  });
});

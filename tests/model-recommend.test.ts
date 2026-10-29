import { describe, expect, it } from "vitest";
import type { SystemInfo } from "../packages/shared/src/types";
import { buildModelRecommendations } from "../packages/core/src/models/recommend";

function sys(opts: {
  vramGb?: number;
  totalRamGb?: number;
  backend?: SystemInfo["recommendedBackend"];
}): SystemInfo {
  const vramGb = opts.vramGb;
  return {
    os: "win32",
    arch: "x64",
    cpuModel: "Test CPU",
    cpuCores: 8,
    totalRamGb: opts.totalRamGb ?? 32,
    freeRamGb: 16,
    gpus:
      vramGb != null
        ? [{ name: "Test GPU", vendor: "NVIDIA", vramGb, index: 0 }]
        : [],
    hasNvidia: vramGb != null,
    hasVulkan: true,
    recommendedBackend: opts.backend ?? (vramGb ? "cuda" : "cpu"),
  };
}

describe("buildModelRecommendations", () => {
  it("prefers fitting models on 8GB VRAM", () => {
    const report = buildModelRecommendations(sys({ vramGb: 8, totalRamGb: 32 }));
    expect(report.vramGb).toBe(8);
    expect(report.summary.length).toBeGreaterThan(10);
    expect(["excellent", "good", "tight"]).toContain(report.items[0].tier);
    expect(report.items.some((i) => i.paramsB <= 8 && i.tier !== "too_heavy")).toBe(true);
    const heavy = report.items.find((i) => i.id === "qwen25-32b");
    expect(heavy).toBeTruthy();
    expect(["tight", "cpu", "too_heavy"]).toContain(heavy!.tier);
  });

  it("marks 14B good/excellent on 24GB", () => {
    const report = buildModelRecommendations(sys({ vramGb: 24, totalRamGb: 64 }));
    const mid = report.items.find((i) => i.id === "qwen25-14b");
    expect(mid).toBeTruthy();
    expect(["excellent", "good"]).toContain(mid!.tier);
    expect(mid!.fitsInVram).toBe(true);
  });

  it("falls back to CPU tiers without VRAM", () => {
    const report = buildModelRecommendations(
      sys({ totalRamGb: 16, backend: "cpu" }),
    );
    expect(report.vramGb).toBeNull();
    expect(report.items.every((i) => !i.fitsInVram)).toBe(true);
    expect(report.items.some((i) => i.tier === "cpu" || i.tier === "too_heavy")).toBe(true);
  });
});

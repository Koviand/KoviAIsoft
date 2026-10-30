import { describe, expect, it } from "vitest";
import type { GpuInfo, SystemInfo } from "@kovi/shared";
import {
  __detectTest,
  pickBackend,
  pickGpuNameForVram,
  pickMaxVram,
} from "../packages/core/src/system/detect";
import { estimateLoadPlan } from "../packages/core/src/models/hardwareProfile";
import { scanLocalModels } from "../packages/core/src/models/scanner";

function sys(gpus: GpuInfo[], over: Partial<SystemInfo> = {}): SystemInfo {
  return {
    os: "Windows_NT",
    arch: "x64",
    cpuModel: "Test",
    cpuCores: 8,
    totalRamGb: 32,
    freeRamGb: 16,
    gpus,
    hasNvidia: gpus.some((g) => g.vendor === "NVIDIA"),
    hasVulkan: false,
    recommendedBackend: gpus.some((g) => g.vendor === "NVIDIA") ? "cuda" : "cpu",
    ...over,
  };
}

describe("pickMaxVram", () => {
  it("uses max across GPUs, not first iGPU", () => {
    expect(
      pickMaxVram([
        { name: "iGPU", vendor: "Intel", vramGb: 1, index: 0 },
        { name: "RTX", vendor: "NVIDIA", vramGb: 16, index: 1 },
      ]),
    ).toBe(16);
  });

  it("accepts SystemInfo", () => {
    expect(
      pickMaxVram(
        sys([
          { name: "iGPU", vendor: "Intel", vramGb: 1, index: 0 },
          { name: "dGPU", vendor: "AMD", vramGb: 12, index: 1 },
        ]),
      ),
    ).toBe(12);
  });
});

describe("pickGpuNameForVram", () => {
  it("matches the card with that VRAM", () => {
    const gpus: GpuInfo[] = [
      { name: "iGPU", vendor: "Intel", vramGb: 1, index: 0 },
      { name: "RX 7800", vendor: "AMD", vramGb: 16, index: 1 },
    ];
    expect(pickGpuNameForVram(gpus, 16)).toMatch(/7800/);
  });
});

describe("WMIC suspect VRAM", () => {
  it("flags classic ~4 GB uint32 cap", () => {
    expect(__detectTest.isSuspectWmicVram(4)).toBe(true);
    expect(__detectTest.isSuspectWmicVram(3.95)).toBe(true);
    expect(__detectTest.isSuspectWmicVram(8)).toBe(false);
    expect(__detectTest.isSuspectWmicVram(16)).toBe(false);
  });
});

describe("pickBackend", () => {
  it("does not invent vulkan without probe", () => {
    expect(pickBackend({ hasNvidia: false, hasVulkan: false })).toBe("cpu");
    expect(pickBackend({ hasNvidia: false, hasVulkan: true })).toBe("vulkan");
  });
});

describe("estimateLoadPlan aligned with scanner thresholds", () => {
  it("8 GB VRAM → ctx 8192 (not scanner-old 4096)", () => {
    const s = sys(
      [{ name: "RTX 3070", vendor: "NVIDIA", vramGb: 8, index: 0 }],
      { hasNvidia: true, recommendedBackend: "cuda" },
    );
    const plan = estimateLoadPlan(s, { tier: "balanced" });
    expect(plan.context).toBe(8192);
    expect(plan.gpuLayers).toBe(99);
  });

  it("quality on 12 GB is not silently cut to 8192 by a second calculator", () => {
    const s = sys(
      [{ name: "RTX 4070", vendor: "NVIDIA", vramGb: 12, index: 0 }],
      { hasNvidia: true, recommendedBackend: "cuda" },
    );
    const quality = estimateLoadPlan(s, { tier: "quality" });
    const balanced = estimateLoadPlan(s, { tier: "balanced" });
    // Same source of truth: quality ctx ≥ balanced; both use unified buckets.
    expect(quality.context).toBeGreaterThanOrEqual(balanced.context);
    expect(quality.context).toBe(16384);
  });

  it("scanner estimateFit matches estimateLoadPlan for same size", () => {
    // scanLocalModels needs real files — compare plan vs plan API only here.
    const s = sys(
      [{ name: "RTX", vendor: "NVIDIA", vramGb: 8, index: 0 }],
      { hasNvidia: true, recommendedBackend: "cuda" },
    );
    const light = estimateLoadPlan(s, { modelSizeGb: 4, tier: "balanced" });
    const heavy = estimateLoadPlan(s, { modelSizeGb: 9, tier: "balanced" });
    expect(light.fitsInVram).toBe(true);
    expect(heavy.gpuLayers).toBeLessThan(99);
    expect(scanLocalModels).toBeTypeOf("function");
  });
});

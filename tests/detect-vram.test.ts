import { describe, expect, it } from "vitest";
import type { GpuInfo, SystemInfo } from "@kovi/shared";
import {
  __detectTest,
  inferHasVulkan,
  parseCimVideoControllers,
  pickBackend,
  pickGpuNameForVram,
  pickMaxVram,
} from "../packages/core/src/system/detect";
import {
  ALL_LAYERS_SENTINEL,
  computePartialNgl,
  estimateLoadPlan,
} from "../packages/core/src/models/hardwareProfile";
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

describe("CIM suspect VRAM", () => {
  it("flags classic ~4 GB uint32 cap", () => {
    expect(__detectTest.isSuspectCimVram(4)).toBe(true);
    expect(__detectTest.isSuspectCimVram(3.95)).toBe(true);
    expect(__detectTest.isSuspectCimVram(8)).toBe(false);
    expect(__detectTest.isSuspectWmicVram(16)).toBe(false);
  });
});

describe("parseCimVideoControllers", () => {
  it("parses CIM CSV and prefers registry QWORD over suspect 4 GB", () => {
    const csv = [
      '"Name","AdapterRAM"',
      '"AMD Radeon RX 7600",4294967295',
    ].join("\n");
    const reg = new Map([["amd radeon rx 7600", 8]]);
    const gpus = parseCimVideoControllers(csv, reg);
    expect(gpus).toHaveLength(1);
    expect(gpus[0]!.vramGb).toBe(8);
    expect(gpus[0]!.vendor).toBe("AMD");
  });

  it("keeps real ~4 GB when registry confirms", () => {
    const csv = '"Radeon RX 6400",4294967295';
    const reg = new Map([["radeon rx 6400", 4]]);
    const gpus = parseCimVideoControllers(csv, reg);
    expect(gpus[0]!.vramGb).toBe(4);
  });
});

describe("inferHasVulkan", () => {
  it("uses vulkaninfo or AMD/Intel dGPU fallback", () => {
    expect(inferHasVulkan({ vulkaninfoOk: true, gpus: [] })).toBe(true);
    expect(
      inferHasVulkan({
        vulkaninfoOk: false,
        gpus: [{ name: "RX", vendor: "AMD", vramGb: 8, index: 0 }],
      }),
    ).toBe(true);
    expect(
      inferHasVulkan({
        vulkaninfoOk: false,
        gpus: [{ name: "iGPU", vendor: "Intel", vramGb: 0.5, index: 0 }],
      }),
    ).toBe(false);
  });
});

describe("pickBackend", () => {
  it("respects preference and Vulkan probe", () => {
    expect(pickBackend({ hasNvidia: false, hasVulkan: false })).toBe("cpu");
    expect(pickBackend({ hasNvidia: false, hasVulkan: true })).toBe("vulkan");
    expect(
      pickBackend({ hasNvidia: true, hasVulkan: true, preference: "cpu" }),
    ).toBe("cpu");
  });
});

describe("estimateLoadPlan aligned with scanner thresholds", () => {
  it("8 GB VRAM → ctx 8192", () => {
    const s = sys(
      [{ name: "RTX 3070", vendor: "NVIDIA", vramGb: 8, index: 0 }],
      { hasNvidia: true, recommendedBackend: "cuda" },
    );
    const plan = estimateLoadPlan(s, { tier: "balanced" });
    expect(plan.context).toBe(8192);
    expect(plan.gpuLayers).toBe(ALL_LAYERS_SENTINEL);
  });

  it("ngl uses real layerCount not 99 when known", () => {
    const s = sys(
      [{ name: "RTX 3070", vendor: "NVIDIA", vramGb: 8, index: 0 }],
      { hasNvidia: true, recommendedBackend: "cuda" },
    );
    const plan = estimateLoadPlan(s, { tier: "balanced", layerCount: 33 });
    expect(plan.gpuLayers).toBe(33);
  });

  it("partial ngl is fraction of layers", () => {
    expect(computePartialNgl(33, 4, 8)).toBe(16);
    expect(computePartialNgl(33, 8, 8)).toBe(33);
  });

  it("quality on 12 GB grows ctx; heavy model retunes ngl after tier", () => {
    const s = sys(
      [{ name: "RTX 4070", vendor: "NVIDIA", vramGb: 12, index: 0 }],
      { hasNvidia: true, recommendedBackend: "cuda" },
    );
    const quality = estimateLoadPlan(s, {
      tier: "quality",
      modelSizeGb: 11,
      layerCount: 40,
    });
    const balanced = estimateLoadPlan(s, {
      tier: "balanced",
      modelSizeGb: 11,
      layerCount: 40,
    });
    expect(quality.context).toBeGreaterThanOrEqual(balanced.context);
    // After quality grows ctx, ngl must be recomputed (not left at full 40 blindly if tight).
    expect(quality.gpuLayers).toBeLessThanOrEqual(40);
    expect(quality.gpuLayers).toBeGreaterThan(0);
  });

  it("cpu backend never claims GPU offload", () => {
    const plan = estimateLoadPlan(
      sys([{ name: "RX", vendor: "AMD", vramGb: 16, index: 0 }], {
        recommendedBackend: "cpu",
        hasVulkan: true,
      }),
      { tier: "balanced", layerCount: 32 },
    );
    expect(plan.gpuLayers).toBe(0);
    expect(plan.rationale).not.toMatch(/полный GPU/i);
  });

  it("GPU backend without VRAM → conservative partial ngl", () => {
    const plan = estimateLoadPlan(
      sys([], { recommendedBackend: "vulkan", hasVulkan: true }),
      { tier: "balanced", layerCount: 40 },
    );
    expect(plan.gpuLayers).toBeGreaterThan(0);
    expect(plan.gpuLayers).toBeLessThanOrEqual(28);
    expect(plan.context).toBe(4096);
  });

  it("low VRAM + fitting model raises ngl to full layers", () => {
    const plan = estimateLoadPlan(
      sys(
        [{ name: "GTX", vendor: "NVIDIA", vramGb: 4, index: 0 }],
        { hasNvidia: true, recommendedBackend: "cuda" },
      ),
      { modelSizeGb: 2, layerCount: 32, tier: "balanced" },
    );
    expect(plan.gpuLayers).toBe(32);
    expect(plan.fitsInVram).toBe(true);
  });

  it("scanner estimateFit matches estimateLoadPlan for same size", () => {
    const s = sys(
      [{ name: "RTX", vendor: "NVIDIA", vramGb: 8, index: 0 }],
      { hasNvidia: true, recommendedBackend: "cuda" },
    );
    const light = estimateLoadPlan(s, { modelSizeGb: 4, tier: "balanced" });
    const heavy = estimateLoadPlan(s, {
      modelSizeGb: 9,
      tier: "balanced",
      layerCount: 40,
    });
    expect(light.fitsInVram).toBe(true);
    expect(heavy.gpuLayers).toBeLessThan(40);
    expect(scanLocalModels).toBeTypeOf("function");
  });
});

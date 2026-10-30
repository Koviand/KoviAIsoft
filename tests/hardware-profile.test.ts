import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AUTO_PC_PROFILE_ID, DEFAULT_LOAD_PROFILES, migrateLoadProfileId } from "@kovi/shared";
import type { SystemInfo } from "@kovi/shared";
import { AppService } from "../packages/core/src/appService";
import {
  buildHardwareTierProfiles,
  suggestHardwareLoadProfile,
} from "../packages/core/src/models/hardwareProfile";

function baseSys(over: Partial<SystemInfo> = {}): SystemInfo {
  return {
    os: "Windows_NT",
    arch: "x64",
    cpuModel: "Test CPU",
    cpuCores: 8,
    totalRamGb: 32,
    freeRamGb: 16,
    gpus: [],
    hasNvidia: false,
    hasVulkan: false,
    recommendedBackend: "cpu",
    ...over,
  };
}

describe("suggestHardwareLoadProfile", () => {
  it("CPU path when no VRAM", () => {
    const s = suggestHardwareLoadProfile(baseSys());
    expect(s.profile.id).toBe(AUTO_PC_PROFILE_ID);
    expect(s.profile.hardwareAware).toBe(true);
    expect(s.profile.gpuLayers).toBe(0);
    expect(s.profile.context).toBe(4096);
    expect(s.profile.flashAttn).toBe(false);
    expect(s.backend).toBe("cpu");
    expect(s.defaultParams.context).toBe(4096);
    expect(s.defaultParams.gpuLayers).toBe(0);
    expect(s.agentMaxSteps).toBe(16);
  });

  it("low VRAM (~4 GB)", () => {
    const s = suggestHardwareLoadProfile(
      baseSys({
        gpus: [{ name: "GTX 1650", vendor: "NVIDIA", vramGb: 4, index: 0 }],
        hasNvidia: true,
        recommendedBackend: "cuda",
      }),
    );
    expect(s.profile.gpuLayers).toBeGreaterThan(0);
    expect(s.profile.gpuLayers).toBeLessThan(99);
    expect(s.profile.context).toBe(4096);
    expect(s.vramGb).toBe(4);
  });

  it("mid VRAM (~8 GB)", () => {
    const s = suggestHardwareLoadProfile(
      baseSys({
        gpus: [{ name: "RTX 3070", vendor: "NVIDIA", vramGb: 8, index: 0 }],
        hasNvidia: true,
        recommendedBackend: "cuda",
      }),
    );
    expect(s.profile.gpuLayers).toBe(99);
    expect(s.profile.context).toBe(8192);
    expect(s.profile.flashAttn).toBe(true);
  });

  it("high VRAM (~16 GB)", () => {
    const s = suggestHardwareLoadProfile(
      baseSys({
        gpus: [{ name: "RTX 4080", vendor: "NVIDIA", vramGb: 16, index: 0 }],
        hasNvidia: true,
        recommendedBackend: "cuda",
      }),
    );
    expect(s.profile.gpuLayers).toBe(99);
    expect(s.profile.context).toBe(16384);
    expect(s.profile.maxTokens).toBeGreaterThanOrEqual(512);
    expect(s.profile.flashAttn).toBe(true);
  });

  it("B2: pickVram uses max across GPUs, not first", () => {
    const s = suggestHardwareLoadProfile(
      baseSys({
        gpus: [
          { name: "iGPU", vendor: "Intel", vramGb: 1, index: 0 },
          { name: "RTX 4080", vendor: "NVIDIA", vramGb: 16, index: 1 },
        ],
        hasNvidia: true,
        recommendedBackend: "cuda",
      }),
    );
    expect(s.vramGb).toBe(16);
    expect(s.profile.context).toBe(16384);
    expect(s.gpuName).toMatch(/4080/);
  });

  it("tightens ngl for heavy model on mid VRAM", () => {
    const s = suggestHardwareLoadProfile(
      baseSys({
        gpus: [{ name: "RTX 3070", vendor: "NVIDIA", vramGb: 8, index: 0 }],
        hasNvidia: true,
        recommendedBackend: "cuda",
      }),
      { modelSizeGb: 7.5 },
    );
    expect(s.profile.gpuLayers).toBeLessThan(99);
    expect(s.rationale).toMatch(/Учтена модель/i);
  });

  it("tiers: fast.ctx < balanced.ctx ≤ quality.ctx on mid-high VRAM", () => {
    const sys = baseSys({
      gpus: [{ name: "RTX 4070", vendor: "NVIDIA", vramGb: 12, index: 0 }],
      hasNvidia: true,
      recommendedBackend: "cuda",
    });
    const fast = suggestHardwareLoadProfile(sys, { tier: "fast" });
    const bal = suggestHardwareLoadProfile(sys, { tier: "balanced" });
    const qual = suggestHardwareLoadProfile(sys, { tier: "quality" });
    expect(fast.profile.context).toBeLessThan(bal.profile.context);
    expect(bal.profile.context).toBeLessThanOrEqual(qual.profile.context);
    expect(fast.profile.id).toBe("fast");
    expect(bal.profile.id).toBe("balanced");
    expect(qual.profile.id).toBe("quality");
    expect(fast.defaultParams.maxTokens).toBeLessThanOrEqual(bal.defaultParams.maxTokens);
  });

  it("buildHardwareTierProfiles returns three tiers", () => {
    const tiers = buildHardwareTierProfiles(
      baseSys({
        gpus: [{ name: "RTX 3080", vendor: "NVIDIA", vramGb: 10, index: 0 }],
        hasNvidia: true,
        recommendedBackend: "cuda",
      }),
    );
    expect(tiers.map((t) => t.id)).toEqual(["fast", "balanced", "quality"]);
    expect(tiers[0]!.context).toBeLessThanOrEqual(tiers[1]!.context);
    expect(tiers[1]!.context).toBeLessThanOrEqual(tiers[2]!.context);
  });
});

describe("migrateLoadProfileId", () => {
  it("maps legacy ids", () => {
    expect(migrateLoadProfileId("max-quality")).toBe("quality");
    expect(migrateLoadProfileId("low-vram")).toBe("fast");
    expect(migrateLoadProfileId("balanced")).toBe("balanced");
  });

  it("DEFAULT_LOAD_PROFILES has fast/balanced/quality/cpu", () => {
    expect(DEFAULT_LOAD_PROFILES.map((p) => p.id)).toEqual([
      "fast",
      "balanced",
      "quality",
      "cpu",
    ]);
  });
});

describe("applyHardwareLoadSettings", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kovi-hw-"));

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("upserts auto-pc + tiers and activates auto-pc", async () => {
    const svc = new AppService(tmp);
    await svc.init();
    try {
      const before = svc.getSettings();
      expect(before.loadProfiles.some((p) => p.id === AUTO_PC_PROFILE_ID)).toBe(false);

      const suggestion = await svc.suggestHardwareLoadSettings();
      expect(suggestion.profile.id).toBe(AUTO_PC_PROFILE_ID);

      const saved = await svc.applyHardwareLoadSettings({ applyBackend: true });
      expect(saved.activeLoadProfileId).toBe(AUTO_PC_PROFILE_ID);
      const auto = saved.loadProfiles.find((p) => p.id === AUTO_PC_PROFILE_ID);
      expect(auto?.name).toBe("Под этот ПК");
      expect(auto?.hardwareAware).toBe(true);
      expect(saved.loadProfiles.some((p) => p.id === "fast")).toBe(true);
      expect(saved.loadProfiles.some((p) => p.id === "quality")).toBe(true);
      expect(saved.runtimeBackendPreference).toBe(suggestion.backend);

      await svc.applyHardwareLoadSettings({ applyBackend: false });
      const again = svc.getSettings();
      expect(again.loadProfiles.filter((p) => p.id === AUTO_PC_PROFILE_ID)).toHaveLength(1);
      expect(again.runtimeBackendPreference).toBe(suggestion.backend);
    } finally {
      await svc.dispose();
    }
  });

  it("applyLoadProfileToSettings syncs defaultParams", async () => {
    const svc = new AppService(tmp + "-tier");
    await svc.init();
    try {
      const saved = await svc.applyLoadProfileToSettings({ profileId: "fast" });
      expect(saved.activeLoadProfileId).toBe("fast");
      const fast = saved.loadProfiles.find((p) => p.id === "fast");
      expect(fast).toBeTruthy();
      expect(saved.defaultParams.context).toBe(fast!.context);
      expect(saved.defaultParams.gpuLayers).toBe(fast!.gpuLayers);
      expect(saved.defaultParams.flashAttn).toBe(fast!.flashAttn);
    } finally {
      await svc.dispose();
    }
  });
});

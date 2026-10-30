import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AUTO_PC_PROFILE_ID } from "@kovi/shared";
import type { SystemInfo } from "@kovi/shared";
import { AppService } from "../packages/core/src/appService";
import { suggestHardwareLoadProfile } from "../packages/core/src/models/hardwareProfile";

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
});

describe("applyHardwareLoadSettings", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kovi-hw-"));

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("upserts auto-pc profile and activates it", async () => {
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
      expect(saved.runtimeBackendPreference).toBe(suggestion.backend);

      // Second apply replaces rather than duplicates.
      await svc.applyHardwareLoadSettings({ applyBackend: false });
      const again = svc.getSettings();
      expect(again.loadProfiles.filter((p) => p.id === AUTO_PC_PROFILE_ID)).toHaveLength(1);
      expect(again.runtimeBackendPreference).toBe(suggestion.backend);
    } finally {
      await svc.dispose();
    }
  });
});

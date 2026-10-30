import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import type { GpuInfo, RuntimeBackend, SystemInfo } from "@kovi/shared";

const execFileAsync = promisify(execFile);

/** WMIC AdapterRAM is uint32 — values near 4 GiB are often capped garbage. */
const WMIC_VRAM_CAP_BYTES = 4 * 1024 ** 3;
const WMIC_VRAM_SUSPECT_MAX = 4.1; // GiB

async function run(cmd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      windowsHide: true,
      timeout: 8000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return stdout.toString();
  } catch {
    return "";
  }
}

/** Max VRAM across GPUs (dedicated card, not first iGPU). */
export function pickMaxVram(
  gpus: Array<{ vramGb?: number | null }> | SystemInfo | null | undefined,
): number | null {
  const list = !gpus ? [] : Array.isArray(gpus) ? gpus : gpus.gpus || [];
  const vals = list
    .map((g) => g.vramGb)
    .filter((x): x is number => typeof x === "number" && x > 0);
  if (!vals.length) return null;
  return Math.max(...vals);
}

export function pickGpuNameForVram(
  gpus: GpuInfo[],
  vramGb: number | null,
): string | null {
  if (!gpus.length) return null;
  if (vramGb == null) return gpus[0]?.name || null;
  const match = gpus.find((g) => g.vramGb === vramGb);
  return match?.name || gpus[0]?.name || null;
}

async function detectNvidia(): Promise<{ gpus: GpuInfo[]; cudaVersion?: string }> {
  const out = await run("nvidia-smi", [
    "--query-gpu=name,memory.total",
    "--format=csv,noheader,nounits",
  ]);
  const gpus: GpuInfo[] = [];
  if (out.trim()) {
    out
      .trim()
      .split(/\r?\n/)
      .forEach((line, index) => {
        const [name, mem] = line.split(",").map((s) => s.trim());
        gpus.push({
          name: name || "NVIDIA GPU",
          vendor: "NVIDIA",
          vramGb: mem ? Number(mem) / 1024 : undefined,
          index,
        });
      });
  }

  const cudaOut = await run("nvidia-smi", []);
  const match = cudaOut.match(/CUDA Version:\s*([\d.]+)/i);
  return { gpus, cudaVersion: match?.[1] };
}

/** Honest Vulkan probe — no vendor guessing. */
async function detectVulkan(): Promise<boolean> {
  const out = await run("vulkaninfo", ["--summary"]);
  return out.includes("GPU") || out.includes("deviceName");
}

/**
 * Registry qwMemorySize is a real QWORD (unlike WMIC AdapterRAM uint32).
 * Display class GUID: {4d36e968-e325-11ce-bfc1-08002be10318}
 */
async function detectGpuVramFromRegistry(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (process.platform !== "win32") return map;

  const ps = [
    "$cls='HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}'",
    "Get-ChildItem $cls -ErrorAction SilentlyContinue |",
    "  Where-Object { $_.PSChildName -match '^\\d+$' } |",
    "  ForEach-Object {",
    "    $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue;",
    "    if ($null -eq $p) { return };",
    "    $name = $p.DriverDesc; if (-not $name) { $name = $p.DeviceDesc };",
    "    $mem = $p.'HardwareInformation.qwMemorySize';",
    "    if ($name -and $mem -and [int64]$mem -gt 0) { Write-Output ('{0}|{1}' -f $name, [int64]$mem) }",
    "  }",
  ].join(" ");

  const out = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps]);
  for (const line of out.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes("|")) continue;
    const idx = trimmed.lastIndexOf("|");
    const name = trimmed.slice(0, idx).trim();
    const bytes = Number(trimmed.slice(idx + 1));
    if (!name || !Number.isFinite(bytes) || bytes <= 0) continue;
    map.set(name.toLowerCase(), bytes / 1024 ** 3);
  }
  return map;
}

function vendorFromName(name: string): GpuInfo["vendor"] {
  if (/nvidia/i.test(name)) return "NVIDIA";
  if (/amd|radeon/i.test(name)) return "AMD";
  if (/intel/i.test(name)) return "Intel";
  return "Other";
}

function isSuspectWmicVram(vramGb: number | undefined): boolean {
  if (vramGb == null || !Number.isFinite(vramGb) || vramGb <= 0) return true;
  // Classic uint32 saturate ≈ 4 GiB (4294967295 bytes → ~4.0)
  return vramGb >= 3.9 && vramGb <= WMIC_VRAM_SUSPECT_MAX;
}

async function detectOtherGpus(): Promise<GpuInfo[]> {
  const registryVram = await detectGpuVramFromRegistry();
  const out = await run("wmic", [
    "path",
    "win32_VideoController",
    "get",
    "Name,AdapterRAM",
    "/format:csv",
  ]);
  const gpus: GpuInfo[] = [];
  const lines = out
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",");
    if (parts.length < 3) continue;
    const adapterRam = Number(parts[1]);
    const name = parts.slice(2).join(",").trim();
    if (!name || /microsoft\s+basic/i.test(name)) continue;

    let vramGb: number | undefined =
      Number.isFinite(adapterRam) && adapterRam > 0 ? adapterRam / (1024 ** 3) : undefined;

    // Prefer registry QWORD when WMIC is missing, zero, or capped at ~4 GB.
    const reg = registryVram.get(name.toLowerCase());
    if (reg != null && reg > 0 && (vramGb == null || isSuspectWmicVram(vramGb) || reg > vramGb + 0.25)) {
      vramGb = Math.round(reg * 10) / 10;
    } else if (vramGb != null && adapterRam >= WMIC_VRAM_CAP_BYTES - 1 && reg == null) {
      // Saturated WMIC with no registry match — treat as unknown rather than "4 GB".
      vramGb = undefined;
    }

    gpus.push({
      name,
      vendor: vendorFromName(name),
      vramGb,
      index: gpus.length,
    });
  }

  // Registry-only devices not listed by WMIC (rare).
  if (gpus.length === 0 && registryVram.size > 0) {
    let i = 0;
    for (const [nameLower, gb] of registryVram) {
      gpus.push({
        name: nameLower,
        vendor: vendorFromName(nameLower),
        vramGb: Math.round(gb * 10) / 10,
        index: i++,
      });
    }
  }

  return gpus;
}

export function pickBackend(info: {
  hasNvidia: boolean;
  hasVulkan: boolean;
  preference?: RuntimeBackend | "auto";
}): RuntimeBackend {
  if (info.preference && info.preference !== "auto") return info.preference;
  if (info.hasNvidia) return "cuda";
  if (info.hasVulkan) return "vulkan";
  return "cpu";
}

export async function detectSystemInfo(
  preference: RuntimeBackend | "auto" = "auto",
): Promise<SystemInfo> {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const cpus = os.cpus();

  const nvidia = await detectNvidia();
  let gpus = nvidia.gpus;
  if (gpus.length === 0) {
    gpus = await detectOtherGpus();
  } else {
    const others = await detectOtherGpus();
    for (const g of others) {
      if (!gpus.some((x) => x.name === g.name)) gpus.push({ ...g, index: gpus.length });
    }
  }

  const hasNvidia = nvidia.gpus.length > 0 || gpus.some((g) => g.vendor === "NVIDIA");
  const hasVulkan = await detectVulkan();
  const recommendedBackend = pickBackend({ hasNvidia, hasVulkan, preference });

  return {
    os: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    cpuModel: cpus[0]?.model?.trim() || "Unknown CPU",
    cpuCores: cpus.length,
    totalRamGb: Math.round((totalMem / 1024 ** 3) * 10) / 10,
    freeRamGb: Math.round((freeMem / 1024 ** 3) * 10) / 10,
    gpus,
    hasNvidia,
    hasVulkan,
    recommendedBackend,
    cudaVersion: nvidia.cudaVersion,
  };
}

export async function sampleVram(): Promise<{
  usedGb: number | null;
  totalGb: number | null;
  gpuUtilPercent: number | null;
}> {
  const out = await run("nvidia-smi", [
    "--query-gpu=memory.used,memory.total,utilization.gpu",
    "--format=csv,noheader,nounits",
  ]);
  const line = out.trim().split(/\r?\n/)[0];
  if (!line) return { usedGb: null, totalGb: null, gpuUtilPercent: null };
  const parts = line.split(",").map((s) => Number(s.trim()));
  const [used, total, util] = parts;
  if (!Number.isFinite(used) || !Number.isFinite(total)) {
    return { usedGb: null, totalGb: null, gpuUtilPercent: null };
  }
  return {
    usedGb: Math.round((used / 1024) * 10) / 10,
    totalGb: Math.round((total / 1024) * 10) / 10,
    gpuUtilPercent: Number.isFinite(util) ? Math.round(util) : null,
  };
}

/** Test helpers — exported for unit tests only. */
export const __detectTest = {
  isSuspectWmicVram,
  WMIC_VRAM_SUSPECT_MAX,
};

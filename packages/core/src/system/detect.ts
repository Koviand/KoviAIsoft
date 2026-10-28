import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import type { GpuInfo, RuntimeBackend, SystemInfo } from "@kovi/shared";

const execFileAsync = promisify(execFile);

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

async function detectVulkan(): Promise<boolean> {
  const out = await run("vulkaninfo", ["--summary"]);
  if (out.includes("GPU") || out.includes("deviceName")) return true;
  // Fallback: presence of common Vulkan loader DLL is not reliable from Node;
  // treat AMD/Intel GPU names from WMIC as potential Vulkan.
  return false;
}

async function detectOtherGpus(): Promise<GpuInfo[]> {
  const out = await run("wmic", ["path", "win32_VideoController", "get", "Name,AdapterRAM", "/format:csv"]);
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
    const vendor = /nvidia/i.test(name)
      ? "NVIDIA"
      : /amd|radeon/i.test(name)
        ? "AMD"
        : /intel/i.test(name)
          ? "Intel"
          : "Other";
    gpus.push({
      name,
      vendor,
      vramGb: Number.isFinite(adapterRam) && adapterRam > 0 ? adapterRam / (1024 ** 3) : undefined,
      index: gpus.length,
    });
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
  let hasVulkan = await detectVulkan();
  if (!hasVulkan && gpus.some((g) => g.vendor === "AMD" || g.vendor === "Intel")) {
    hasVulkan = true;
  }

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

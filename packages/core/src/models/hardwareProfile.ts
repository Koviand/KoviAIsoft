import type {
  GenerationParams,
  HardwareLoadSuggestion,
  LoadProfile,
  SystemInfo,
} from "@kovi/shared";
import { AUTO_PC_PROFILE_ID, DEFAULT_GENERATION_PARAMS } from "@kovi/shared";

export { AUTO_PC_PROFILE_ID };
export type { HardwareLoadSuggestion };

function pickVram(sys: SystemInfo): number | null {
  const v = sys.gpus.map((g) => g.vramGb).find((x): x is number => typeof x === "number" && x > 0);
  return v ?? null;
}

/**
 * Suggest llama-server load settings from detected PC hardware.
 * Optional modelSizeGb tightens ngl/ctx for a specific GGUF.
 */
export function suggestHardwareLoadProfile(
  sys: SystemInfo,
  opts?: { modelSizeGb?: number },
): HardwareLoadSuggestion {
  const vramGb = pickVram(sys);
  const ramGb = sys.totalRamGb || 16;
  const backend = sys.recommendedBackend;
  const gpuName = sys.gpus[0]?.name || null;
  const modelSizeGb =
    typeof opts?.modelSizeGb === "number" && opts.modelSizeGb > 0 ? opts.modelSizeGb : null;

  let gpuLayers: number;
  let context: number;
  let flashAttn: boolean;
  let rationale: string;

  if (vramGb == null || vramGb <= 0) {
    gpuLayers = 0;
    context = 4096;
    flashAttn = false;
    rationale = `GPU VRAM не обнаружена — загрузка на CPU/RAM (${ramGb.toFixed(0)} GB). Backend: ${backend}.`;
  } else if (vramGb < 6) {
    gpuLayers = 28;
    context = 4096;
    flashAttn = false;
    rationale = `Мало VRAM (${vramGb.toFixed(1)} GB) — частичный offload (ngl≈${gpuLayers}), ctx ${context}. Backend: ${backend}.`;
  } else if (vramGb < 10) {
    gpuLayers = 99;
    context = 8192;
    flashAttn = backend === "cuda";
    rationale = `Средняя VRAM (${vramGb.toFixed(1)} GB) — почти всё на GPU, ctx ${context}${flashAttn ? ", flash-attn" : ""}. Backend: ${backend}.`;
  } else if (vramGb < 16) {
    gpuLayers = 99;
    context = 8192;
    flashAttn = backend === "cuda" || backend === "vulkan";
    rationale = `Достаточно VRAM (${vramGb.toFixed(1)} GB) — полный GPU, ctx ${context}${flashAttn ? ", flash-attn" : ""}. Backend: ${backend}.`;
  } else {
    gpuLayers = 99;
    context = 16384;
    flashAttn = backend === "cuda" || backend === "vulkan";
    rationale = `Большая VRAM (${vramGb.toFixed(1)} GB) — полный GPU, длинный контекст ${context}${flashAttn ? ", flash-attn" : ""}. Backend: ${backend}.`;
  }

  // Tighten for a concrete model weight if provided.
  if (modelSizeGb != null && vramGb != null && vramGb > 0) {
    const kv = context * 0.00025;
    const need = modelSizeGb + kv;
    if (need >= vramGb * 0.9) {
      const ratio = vramGb / need;
      gpuLayers = Math.max(0, Math.floor(ratio * 99));
      if (context > 4096 && need > vramGb * 0.75) {
        context = 4096;
      }
      flashAttn = flashAttn && gpuLayers >= 40;
      rationale += ` Учтена модель ≈${modelSizeGb.toFixed(1)} GB → ngl ${gpuLayers}, ctx ${context}.`;
    }
  } else if (modelSizeGb != null && (vramGb == null || vramGb <= 0)) {
    // CPU path: shrink context for large models on limited RAM.
    if (modelSizeGb > ramGb * 0.4) {
      context = 4096;
      rationale += ` Модель ≈${modelSizeGb.toFixed(1)} GB велика для RAM — ctx ${context}.`;
    }
  }

  const maxTokens = Math.max(512, Math.min(4096, Math.floor(context * 0.3)));

  const profile: LoadProfile = {
    id: AUTO_PC_PROFILE_ID,
    name: "Под этот ПК",
    gpuLayers,
    context,
    flashAttn,
    maxTokens,
    hardwareAware: true,
  };

  // Chat defaults mirror load profile; keep sampling mild for local models.
  const defaultParams: GenerationParams = {
    ...DEFAULT_GENERATION_PARAMS,
    context,
    gpuLayers,
    maxTokens,
    flashAttn,
    temperature: vramGb != null && vramGb >= 8 ? 0.7 : 0.6,
    topP: 0.95,
    topK: 40,
  };

  // More VRAM/RAM → more agent steps before context pressure.
  let agentMaxSteps = 24;
  if (vramGb != null && vramGb >= 16 && ramGb >= 32) agentMaxSteps = 48;
  else if (vramGb != null && vramGb >= 10) agentMaxSteps = 40;
  else if (vramGb != null && vramGb >= 6) agentMaxSteps = 32;
  else if (vramGb == null || vramGb <= 0) agentMaxSteps = 16;

  rationale += ` Чат: ctx ${context}, maxTokens ${maxTokens}, ngl ${gpuLayers}; агент до ${agentMaxSteps} шагов.`;

  return {
    profile,
    rationale,
    backend,
    vramGb,
    ramGb,
    gpuName,
    defaultParams,
    agentMaxSteps,
  };
}

export function isAutoPcProfile(profileId: string | null | undefined): boolean {
  return profileId === AUTO_PC_PROFILE_ID;
}

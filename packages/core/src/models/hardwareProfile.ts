import type {
  GenerationParams,
  HardwareLoadSuggestion,
  LoadProfile,
  SystemInfo,
} from "@kovi/shared";
import { AUTO_PC_PROFILE_ID, DEFAULT_GENERATION_PARAMS } from "@kovi/shared";

export { AUTO_PC_PROFILE_ID };
export type { HardwareLoadSuggestion };

/** UX load tiers: speed vs quality tradeoff on top of hardware base. */
export type LoadTier = "fast" | "balanced" | "quality";

export const LOAD_TIER_IDS = ["fast", "balanced", "quality"] as const;

function pickVram(sys: SystemInfo): number | null {
  const vals = sys.gpus
    .map((g) => g.vramGb)
    .filter((x): x is number => typeof x === "number" && x > 0);
  if (!vals.length) return null;
  return Math.max(...vals);
}

function pickGpuName(sys: SystemInfo, vramGb: number | null): string | null {
  if (vramGb == null) return sys.gpus[0]?.name || null;
  const match = sys.gpus.find((g) => g.vramGb === vramGb);
  return match?.name || sys.gpus[0]?.name || null;
}

function applyTier(
  tier: LoadTier,
  base: {
    gpuLayers: number;
    context: number;
    flashAttn: boolean;
    maxTokens: number;
    agentMaxSteps: number;
    temperature: number;
  },
  vramGb: number | null,
  backend: SystemInfo["recommendedBackend"],
): typeof base {
  if (tier === "balanced") return base;

  if (tier === "fast") {
    const context = Math.max(2048, Math.floor(base.context * 0.5));
    const maxTokens = Math.max(512, Math.min(2048, Math.floor(context * 0.25)));
    return {
      gpuLayers: base.gpuLayers,
      context,
      flashAttn: base.flashAttn || (vramGb != null && vramGb >= 6 && backend === "cuda"),
      maxTokens,
      agentMaxSteps: Math.max(12, Math.floor(base.agentMaxSteps * 0.75)),
      temperature: Math.min(base.temperature, 0.6),
    };
  }

  // quality
  let context = Math.min(16384, Math.max(base.context, Math.floor(base.context * 2)));
  if (vramGb != null && vramGb < 10) {
    context = Math.min(context, 8192);
  }
  if (vramGb != null && vramGb < 6) {
    context = Math.min(context, 4096);
  }
  const maxTokens = Math.max(1024, Math.min(4096, Math.floor(context * 0.35)));
  return {
    gpuLayers: base.gpuLayers,
    context,
    flashAttn:
      base.flashAttn ||
      (vramGb != null && vramGb >= 8 && (backend === "cuda" || backend === "vulkan")),
    maxTokens,
    agentMaxSteps: Math.min(56, Math.floor(base.agentMaxSteps * 1.15)),
    temperature: Math.max(base.temperature, 0.7),
  };
}

/**
 * Suggest llama-server load settings from detected PC hardware.
 * Optional modelSizeGb tightens ngl/ctx; tier adjusts speed vs quality.
 */
export function suggestHardwareLoadProfile(
  sys: SystemInfo,
  opts?: { modelSizeGb?: number; tier?: LoadTier },
): HardwareLoadSuggestion {
  const vramGb = pickVram(sys);
  const ramGb = sys.totalRamGb || 16;
  const backend = sys.recommendedBackend;
  const gpuName = pickGpuName(sys, vramGb);
  const modelSizeGb =
    typeof opts?.modelSizeGb === "number" && opts.modelSizeGb > 0 ? opts.modelSizeGb : null;
  const tier: LoadTier = opts?.tier || "balanced";

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
    if (modelSizeGb > ramGb * 0.4) {
      context = 4096;
      rationale += ` Модель ≈${modelSizeGb.toFixed(1)} GB велика для RAM — ctx ${context}.`;
    }
  }

  let maxTokens = Math.max(512, Math.min(4096, Math.floor(context * 0.3)));
  let agentMaxSteps = 24;
  if (vramGb != null && vramGb >= 16 && ramGb >= 32) agentMaxSteps = 48;
  else if (vramGb != null && vramGb >= 10) agentMaxSteps = 40;
  else if (vramGb != null && vramGb >= 6) agentMaxSteps = 32;
  else if (vramGb == null || vramGb <= 0) agentMaxSteps = 16;
  let temperature = vramGb != null && vramGb >= 8 ? 0.7 : 0.6;

  const tuned = applyTier(
    tier,
    { gpuLayers, context, flashAttn, maxTokens, agentMaxSteps, temperature },
    vramGb,
    backend,
  );
  gpuLayers = tuned.gpuLayers;
  context = tuned.context;
  flashAttn = tuned.flashAttn;
  maxTokens = tuned.maxTokens;
  agentMaxSteps = tuned.agentMaxSteps;
  temperature = tuned.temperature;

  const tierLabel =
    tier === "fast" ? "Быстро" : tier === "quality" ? "Качество" : "Баланс";
  if (tier !== "balanced") {
    rationale += ` Уровень «${tierLabel}»: ctx ${context}, maxTokens ${maxTokens}.`;
  }

  const profileId = tier === "balanced" && !opts?.tier ? AUTO_PC_PROFILE_ID : tier;
  const profileName =
    tier === "fast"
      ? "Быстро"
      : tier === "quality"
        ? "Качество"
        : opts?.tier
          ? "Баланс"
          : "Под этот ПК";

  const profile: LoadProfile = {
    id: profileId === AUTO_PC_PROFILE_ID ? AUTO_PC_PROFILE_ID : tier,
    name: profileName,
    gpuLayers,
    context,
    flashAttn,
    maxTokens,
    hardwareAware: true,
  };

  const defaultParams: GenerationParams = {
    ...DEFAULT_GENERATION_PARAMS,
    context,
    gpuLayers,
    maxTokens,
    flashAttn,
    temperature,
    topP: 0.95,
    topK: tier === "fast" ? 30 : 40,
    minP: tier === "quality" ? 0.05 : 0.05,
  };

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

/** Build fast/balanced/quality profiles for this PC (and optional model size). */
export function buildHardwareTierProfiles(
  sys: SystemInfo,
  opts?: { modelSizeGb?: number },
): LoadProfile[] {
  return (["fast", "balanced", "quality"] as const).map((tier) => {
    const s = suggestHardwareLoadProfile(sys, { ...opts, tier });
    return {
      ...s.profile,
      id: tier,
      name: tier === "fast" ? "Быстро" : tier === "quality" ? "Качество" : "Баланс",
      hardwareAware: true,
    };
  });
}

export function isAutoPcProfile(profileId: string | null | undefined): boolean {
  return profileId === AUTO_PC_PROFILE_ID;
}

/** Sync defaultParams load fields from an active LoadProfile. */
export function mergeProfileIntoDefaultParams(
  defaults: GenerationParams,
  profile: LoadProfile,
): GenerationParams {
  return {
    ...defaults,
    gpuLayers: profile.gpuLayers,
    context: profile.context,
    flashAttn: profile.flashAttn,
    maxTokens: profile.maxTokens ?? defaults.maxTokens,
  };
}

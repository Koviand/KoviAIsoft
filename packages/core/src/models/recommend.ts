import type {
  ModelPerfTier,
  ModelRecommendation,
  ModelRecommendationsReport,
  SystemInfo,
} from "@kovi/shared";

interface CatalogEntry {
  id: string;
  name: string;
  family: string;
  description: string;
  paramsB: number;
  hfRepo: string;
  tags: string[];
  /** Approximate sizes (GB) by preferred quant order. */
  quants: Array<{ quant: string; sizeGb: number }>;
}

/** Curated GGUF picks popular for local chat / coding on Windows. */
export const MODEL_CATALOG: CatalogEntry[] = [
  {
    id: "lfm2-1.2b",
    name: "LFM2 1.2B",
    family: "Liquid LFM",
    description: "Очень быстрая лёгкая модель для чата и простых задач",
    paramsB: 1.2,
    hfRepo: "LiquidAI/LFM2-1.2B-GGUF",
    tags: ["чат", "быстрая", "новичкам"],
    quants: [
      { quant: "Q8_0", sizeGb: 1.3 },
      { quant: "Q4_K_M", sizeGb: 0.8 },
    ],
  },
  {
    id: "lfm2-2.6b",
    name: "LFM2 2.6B",
    family: "Liquid LFM",
    description: "Баланс качества и скорости; хорошо для повседневного чата",
    paramsB: 2.6,
    hfRepo: "LiquidAI/LFM2-2.6B-GGUF",
    tags: ["чат", "баланс"],
    quants: [
      { quant: "Q5_K_M", sizeGb: 1.9 },
      { quant: "Q4_K_M", sizeGb: 1.6 },
    ],
  },
  {
    id: "qwen25-3b",
    name: "Qwen2.5 3B Instruct",
    family: "Qwen",
    description: "Сильная малая модель: чат, инструкции, простой код",
    paramsB: 3,
    hfRepo: "Qwen/Qwen2.5-3B-Instruct-GGUF",
    tags: ["чат", "код", "многоязычная"],
    quants: [
      { quant: "Q5_K_M", sizeGb: 2.3 },
      { quant: "Q4_K_M", sizeGb: 2.0 },
    ],
  },
  {
    id: "phi4-mini",
    name: "Phi-4 Mini Instruct",
    family: "Microsoft Phi",
    description: "Компактная модель Microsoft: рассуждения и инструкции",
    paramsB: 3.8,
    hfRepo: "unsloth/Phi-4-mini-instruct-GGUF",
    tags: ["чат", "рассуждения"],
    quants: [
      { quant: "Q5_K_M", sizeGb: 2.8 },
      { quant: "Q4_K_M", sizeGb: 2.4 },
    ],
  },
  {
    id: "llama32-3b",
    name: "Llama 3.2 3B Instruct",
    family: "Meta Llama",
    description: "Лёгкая Llama для чата на слабом/среднем GPU",
    paramsB: 3,
    hfRepo: "bartowski/Llama-3.2-3B-Instruct-GGUF",
    tags: ["чат", "универсальная"],
    quants: [
      { quant: "Q5_K_M", sizeGb: 2.3 },
      { quant: "Q4_K_M", sizeGb: 2.0 },
    ],
  },
  {
    id: "qwen25-7b",
    name: "Qwen2.5 7B Instruct",
    family: "Qwen",
    description: "Отличный универсальный выбор: чат, код, агент на 8+ GB VRAM",
    paramsB: 7,
    hfRepo: "Qwen/Qwen2.5-7B-Instruct-GGUF",
    tags: ["чат", "код", "агент", "рекомендуем"],
    quants: [
      { quant: "Q5_K_M", sizeGb: 5.4 },
      { quant: "Q4_K_M", sizeGb: 4.7 },
      { quant: "Q3_K_M", sizeGb: 3.8 },
    ],
  },
  {
    id: "mistral-7b",
    name: "Mistral 7B Instruct",
    family: "Mistral",
    description: "Классика локального чата; стабильно работает через llama.cpp",
    paramsB: 7,
    hfRepo: "TheBloke/Mistral-7B-Instruct-v0.2-GGUF",
    tags: ["чат", "классика"],
    quants: [
      { quant: "Q5_K_M", sizeGb: 5.1 },
      { quant: "Q4_K_M", sizeGb: 4.4 },
    ],
  },
  {
    id: "llama31-8b",
    name: "Llama 3.1 8B Instruct",
    family: "Meta Llama",
    description: "Сильный общий чат/агент при 8–12 GB VRAM",
    paramsB: 8,
    hfRepo: "bartowski/Meta-Llama-3.1-8B-Instruct-GGUF",
    tags: ["чат", "агент", "универсальная"],
    quants: [
      { quant: "Q5_K_M", sizeGb: 5.7 },
      { quant: "Q4_K_M", sizeGb: 4.9 },
      { quant: "Q3_K_M", sizeGb: 4.0 },
    ],
  },
  {
    id: "gemma2-9b",
    name: "Gemma 2 9B Instruct",
    family: "Google Gemma",
    description: "Качественные ответы; комфортнее на 12+ GB VRAM",
    paramsB: 9,
    hfRepo: "bartowski/gemma-2-9b-it-GGUF",
    tags: ["чат", "качество"],
    quants: [
      { quant: "Q4_K_M", sizeGb: 5.8 },
      { quant: "Q3_K_M", sizeGb: 4.8 },
    ],
  },
  {
    id: "qwen25-14b",
    name: "Qwen2.5 14B Instruct",
    family: "Qwen",
    description: "Выше качество рассуждений; нужен запас VRAM или offload",
    paramsB: 14,
    hfRepo: "Qwen/Qwen2.5-14B-Instruct-GGUF",
    tags: ["чат", "код", "качество"],
    quants: [
      { quant: "Q4_K_M", sizeGb: 8.9 },
      { quant: "Q3_K_M", sizeGb: 7.3 },
      { quant: "Q2_K", sizeGb: 5.6 },
    ],
  },
  {
    id: "qwen25-32b",
    name: "Qwen2.5 32B Instruct",
    family: "Qwen",
    description: "Тяжёлая мощная модель; для 24 GB VRAM или CPU/RAM offload",
    paramsB: 32,
    hfRepo: "Qwen/Qwen2.5-32B-Instruct-GGUF",
    tags: ["качество", "тяжёлая"],
    quants: [
      { quant: "Q4_K_M", sizeGb: 19.8 },
      { quant: "Q3_K_M", sizeGb: 16.0 },
      { quant: "Q2_K", sizeGb: 12.2 },
    ],
  },
  {
    id: "deepseek-r1-distill-8b",
    name: "DeepSeek R1 Distill Llama 8B",
    family: "DeepSeek",
    description: "Дистиллят reasoning-модели; удобна для «подумай шаг за шагом»",
    paramsB: 8,
    hfRepo: "bartowski/DeepSeek-R1-Distill-Llama-8B-GGUF",
    tags: ["рассуждения", "чат"],
    quants: [
      { quant: "Q5_K_M", sizeGb: 5.7 },
      { quant: "Q4_K_M", sizeGb: 4.9 },
    ],
  },
];

function pickVram(sys: SystemInfo): number | null {
  const v = sys.gpus.map((g) => g.vramGb).find((x): x is number => typeof x === "number" && x > 0);
  return v ?? null;
}

function pickQuant(
  entry: CatalogEntry,
  budgetGb: number,
): { quant: string; sizeGb: number } {
  const fitting = entry.quants.filter((q) => q.sizeGb <= budgetGb);
  if (fitting.length) return fitting[0];
  return entry.quants[entry.quants.length - 1];
}

function contextForVram(vramGb: number | null): number {
  if (vramGb == null) return 4096;
  if (vramGb < 8) return 4096;
  if (vramGb >= 16) return 16384;
  return 8192;
}

function estimateNgl(
  sizeGb: number,
  context: number,
  vramGb: number | null,
): { ngl: number; fits: boolean } {
  if (vramGb == null || vramGb <= 0) return { ngl: 0, fits: false };
  const kv = context * 0.00025;
  const need = sizeGb + kv;
  const fits = need < vramGb * 0.9;
  if (fits) return { ngl: 99, fits: true };
  const ratio = vramGb / need;
  return { ngl: Math.max(0, Math.floor(ratio * 99)), fits: false };
}

function classifyTier(
  sizeGb: number,
  vramGb: number | null,
  ramGb: number,
  fits: boolean,
  ngl: number,
): ModelPerfTier {
  if (vramGb && fits && sizeGb < vramGb * 0.55) return "excellent";
  if (vramGb && fits) return "good";
  if (vramGb && ngl >= 24) return "tight";
  if (sizeGb < ramGb * 0.55) return "cpu";
  return "too_heavy";
}

function tierVerdict(tier: ModelPerfTier, quant: string, ngl: number): string {
  switch (tier) {
    case "excellent":
      return `Отлично влезет в VRAM (${quant}, ngl=${ngl}). Комфортный выбор.`;
    case "good":
      return `Хорошо работает на GPU (${quant}). Рекомендуемый вариант под ваше железо.`;
    case "tight":
      return `Влезет частично (offload, ngl≈${ngl}). Работает, но медленнее полного GPU.`;
    case "cpu":
      return `На GPU тесно — лучше CPU/RAM (${quant}). Ответы будут заметно медленнее.`;
    case "too_heavy":
      return `Слишком тяжёлая для этого ПК. Возьмите меньшую модель или агрессивный квант.`;
  }
}

function tierSpeed(tier: ModelPerfTier, backend: string): string {
  switch (tier) {
    case "excellent":
      return `Ожидайте высокую скорость (${backend.toUpperCase()}, почти всё на GPU)`;
    case "good":
      return `Ожидайте хорошую скорость на ${backend.toUpperCase()}`;
    case "tight":
      return "Средняя скорость: часть слоёв на GPU, часть на RAM";
    case "cpu":
      return "Низкая скорость (CPU/RAM). Подходит для коротких ответов";
    case "too_heavy":
      return "Практически непригодно без апгрейда RAM/VRAM";
  }
}

function scoreTier(tier: ModelPerfTier, paramsB: number, tags: string[]): number {
  const base =
    tier === "excellent"
      ? 100
      : tier === "good"
        ? 80
        : tier === "tight"
          ? 45
          : tier === "cpu"
            ? 25
            : 5;
  const sweet = paramsB >= 3 && paramsB <= 8 ? 8 : paramsB < 3 ? 3 : 0;
  const boost = tags.includes("рекомендуем") ? 5 : 0;
  return base + sweet + boost - Math.abs(paramsB - 7) * 0.4;
}

export function buildModelRecommendations(sys: SystemInfo): ModelRecommendationsReport {
  const vramGb = pickVram(sys);
  const ramGb = sys.totalRamGb || 16;
  const backend = sys.recommendedBackend;
  const gpuName = sys.gpus[0]?.name || null;
  // Prefer fitting into VRAM; if none, use half of RAM as soft budget for CPU mode.
  const budgetGb = vramGb && vramGb > 0 ? vramGb * 0.85 : ramGb * 0.45;
  const context = contextForVram(vramGb);

  const items: ModelRecommendation[] = MODEL_CATALOG.map((entry) => {
    const picked = pickQuant(entry, budgetGb);
    const { ngl, fits } = estimateNgl(picked.sizeGb, context, vramGb);
    const tier = classifyTier(picked.sizeGb, vramGb, ramGb, fits, ngl);
    return {
      id: entry.id,
      name: entry.name,
      family: entry.family,
      description: entry.description,
      paramsB: entry.paramsB,
      hfRepo: entry.hfRepo,
      suggestedQuant: picked.quant,
      approxSizeBytes: Math.round(picked.sizeGb * 1024 ** 3),
      tags: entry.tags,
      tier,
      verdict: tierVerdict(tier, picked.quant, ngl),
      expectedSpeed: tierSpeed(tier, backend),
      recommendedNgl: ngl,
      recommendedContext: context,
      fitsInVram: fits,
      score: scoreTier(tier, entry.paramsB, entry.tags),
    };
  }).sort((a, b) => b.score - a.score);

  const top = items.filter((i) => i.tier === "excellent" || i.tier === "good").slice(0, 3);
  const vramLabel = vramGb != null ? `${vramGb.toFixed(1)} GB VRAM` : "без GPU VRAM";
  const summary =
    top.length > 0
      ? `На этом ПК (${vramLabel}, ${ramGb.toFixed(0)} GB RAM, backend ${backend}) лучше всего: ${top
          .map((t) => t.name)
          .join(", ")}.`
      : `На этом ПК (${vramLabel}, ${ramGb.toFixed(0)} GB RAM) тяжёлые модели будут медленными — начните с 1–3B GGUF.`;

  return {
    generatedAt: new Date().toISOString(),
    vramGb,
    ramGb,
    backend,
    gpuName,
    summary,
    items,
  };
}

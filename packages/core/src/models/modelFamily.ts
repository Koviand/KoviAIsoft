export type ModelFamily =
  | "qwen"
  | "deepseek"
  | "lfm"
  | "llama"
  | "mistral"
  | "gemma"
  | "other";

/** Prefer GGUF name/path over opaque hash id for family / size heuristics. */
export function modelIdentityForTuning(status: {
  loadedModelId?: string | null;
  loadedModelName?: string | null;
  loadedModelPath?: string | null;
}): string {
  const name = status.loadedModelName?.trim();
  if (name) return name;
  const p = status.loadedModelPath?.trim();
  if (p) return p;
  return status.loadedModelId?.trim() || "";
}

/** Detect instruct family from GGUF filename / HF id / display name. */
export function detectModelFamily(nameOrPath: string): ModelFamily {
  const s = nameOrPath.toLowerCase().replace(/\\/g, "/");
  if (/deepseek|r1[-_]?distill|reasoner/.test(s)) return "deepseek";
  if (/liquid|lfm2|lfm[-_]?2|lfm3/.test(s)) return "lfm";
  if (/qwen|qwq/.test(s)) return "qwen";
  if (/mistral|mixtral|pixtral/.test(s)) return "mistral";
  if (/gemma/.test(s)) return "gemma";
  if (/llama|meta-llama|hermes|vicuna|wizardlm/.test(s)) return "llama";
  return "other";
}

export type AgentFamilyTuning = {
  temperatureCap: number;
  minP: number;
  /** Extra system nudge when constraints fall back to none. */
  jsonNudge: string;
  /** Reject prose-only reasoning as actionable JSON. */
  rejectProseReasoning: boolean;
};

/** Heuristic: tiny GGUF names get stricter JSON enforcement (not every unknown). */
export function looksLikeSmallOrUnknownModel(nameOrPath: string): boolean {
  const s = nameOrPath.toLowerCase().replace(/\\/g, "/");
  // Opaque hash ids (16 hex) — do not treat as tiny.
  if (/^[a-f0-9]{12,40}$/i.test(nameOrPath.trim())) return false;
  if (
    /\b(0\.5b|0\.6b|0\.8b|1b|1\.2b|1\.5b|1\.7b|2b|2\.6b|3b|3\.5b|4b|5b|6b|350m|500m)\b/.test(
      s,
    )
  ) {
    return true;
  }
  if (/tiny|mini(?!lm)|nano|smol/.test(s)) return true;
  // Unknown family alone is not "small" — only tighten when name is empty/garbage.
  if (!s.trim() || s.length < 3) return true;
  return false;
}

/**
 * First constraint mode for agent JSON by family/size.
 * Tiny / deepseek / lfm / unknown skip native tools (often empty or prose).
 */
export function preferredConstraintMode(
  family: ModelFamily,
  nameOrPath = "",
): "tools" | "json_schema" | "grammar" | "none" {
  const weak = nameOrPath
    ? looksLikeSmallOrUnknownModel(nameOrPath)
    : family === "other";
  if (weak || family === "other") return "json_schema";
  if (family === "deepseek" || family === "lfm") return "json_schema";
  return "tools";
}

export function agentTuningForFamily(
  family: ModelFamily,
  nameOrPath = "",
): AgentFamilyTuning {
  const jsonNudge =
    "Отвечай ТОЛЬКО одним JSON-объектом {\"thought\",\"tool\"|null,\"tools\"?,\"final\"|null} без markdown и без XML tool_call.";
  const weak = nameOrPath ? looksLikeSmallOrUnknownModel(nameOrPath) : family === "other";
  const weakExtra = weak
    ? " Не отказывайся текстом («не могу», «уточните задачу»). Это локальный coding-агент: один JSON с tool (write_file/run_terminal) или plan."
    : "";
  switch (family) {
    case "deepseek":
      return {
        temperatureCap: 0.3,
        minP: 0.05,
        jsonNudge:
          jsonNudge +
          " Не клади итог только в thinking — нужен JSON в content." +
          weakExtra,
        rejectProseReasoning: true,
      };
    case "qwen":
      return {
        temperatureCap: weak ? 0.25 : 0.35,
        minP: 0.05,
        jsonNudge: jsonNudge + weakExtra,
        rejectProseReasoning: weak,
      };
    case "lfm":
      return {
        temperatureCap: 0.35,
        minP: 0.08,
        jsonNudge: jsonNudge + weakExtra,
        rejectProseReasoning: weak,
      };
    case "llama":
    case "mistral":
    case "gemma":
      return {
        temperatureCap: weak ? 0.3 : 0.4,
        minP: 0.05,
        jsonNudge: jsonNudge + weakExtra,
        rejectProseReasoning: weak,
      };
    default:
      return {
        temperatureCap: 0.35,
        minP: 0.05,
        jsonNudge:
          jsonNudge +
          " Никакого обычного текста вне JSON — иначе шаг будет отклонён." +
          weakExtra,
        rejectProseReasoning: true,
      };
  }
}

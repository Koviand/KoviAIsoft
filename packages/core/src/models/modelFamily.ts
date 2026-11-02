export type ModelFamily =
  | "qwen"
  | "deepseek"
  | "lfm"
  | "llama"
  | "mistral"
  | "gemma"
  | "other";

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

/** Heuristic: tiny / unknown GGUF names get stricter JSON enforcement. */
export function looksLikeSmallOrUnknownModel(nameOrPath: string): boolean {
  const s = nameOrPath.toLowerCase();
  if (/\b(0\.5b|0\.6b|1b|1\.5b|1\.7b|2b|3b|3\.5b|4b)\b/.test(s)) return true;
  if (/tiny|mini(?!lm)|nano|smol/.test(s)) return true;
  return detectModelFamily(nameOrPath) === "other";
}

export function agentTuningForFamily(
  family: ModelFamily,
  nameOrPath = "",
): AgentFamilyTuning {
  const jsonNudge =
    "Отвечай ТОЛЬКО одним JSON-объектом {\"thought\",\"tool\"|null,\"tools\"?,\"final\"|null} без markdown и без XML tool_call.";
  const weak = nameOrPath ? looksLikeSmallOrUnknownModel(nameOrPath) : family === "other";
  switch (family) {
    case "deepseek":
      return {
        temperatureCap: 0.3,
        minP: 0.05,
        jsonNudge:
          jsonNudge +
          " Не клади итог только в thinking — нужен JSON в content.",
        rejectProseReasoning: true,
      };
    case "qwen":
      return {
        temperatureCap: 0.35,
        minP: 0.05,
        jsonNudge,
        rejectProseReasoning: weak,
      };
    case "lfm":
      return {
        temperatureCap: 0.35,
        minP: 0.08,
        jsonNudge,
        rejectProseReasoning: weak,
      };
    case "llama":
    case "mistral":
    case "gemma":
      return {
        temperatureCap: 0.4,
        minP: 0.05,
        jsonNudge,
        rejectProseReasoning: weak,
      };
    default:
      return {
        temperatureCap: 0.35,
        minP: 0.05,
        jsonNudge:
          jsonNudge + " Никакого обычного текста вне JSON — иначе шаг будет отклонён.",
        rejectProseReasoning: true,
      };
  }
}

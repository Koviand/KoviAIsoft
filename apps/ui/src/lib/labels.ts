/** Shared Russian UI labels — keep copy consistent across pages. */

export const PARAM_LABELS: Record<string, string> = {
  temperature: "Температура",
  topP: "Top-P",
  topK: "Top-K",
  minP: "Min-P",
  maxTokens: "Макс. токенов",
  context: "Контекст",
  gpuLayers: "Слои GPU (ngl)",
  seed: "Seed",
};

export function paramLabel(key: string): string {
  return PARAM_LABELS[key] || key;
}

export function riskRu(risk: string): string {
  if (risk === "high") return "высокий риск";
  if (risk === "medium") return "средний риск";
  if (risk === "low") return "низкий риск";
  return risk;
}

export function statusRu(status: string): string {
  switch (status) {
    case "pending":
      return "ждёт";
    case "running":
      return "идёт";
    case "done":
      return "готово";
    case "failed":
    case "error":
      return "ошибка";
    case "skipped":
      return "пропуск";
    default:
      return status;
  }
}

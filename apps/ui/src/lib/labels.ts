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

/**
 * Agent `step_done.detail` is often English telemetry.
 * Soft details must NOT complete the checklist — only tool success via `plan` event does.
 */
export function isSoftAgentStepDetail(detail: string | undefined): boolean {
  if (!detail) return true;
  return /^(no tool|repair|truncation|final_blocked|identical tool|non-advancing|Жду план|План:|План по шаблону|finish window|truncation →|deny|blocked)/i.test(
    detail.trim(),
  );
}

export function agentStepDetailRu(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  const t = detail.trim();
  if (/^no tool$/i.test(t)) return "модель не вызвала tool";
  if (/^repair$/i.test(t)) return "починка JSON";
  if (/^truncation$/i.test(t)) return "ответ обрезан";
  if (/truncation\s*→\s*final/i.test(t)) return "обрезка → итог";
  if (/^final_blocked$/i.test(t)) return "final рано";
  if (/^identical tool$/i.test(t)) return "повтор tool";
  if (/non-advancing/i.test(t)) return "только разведка";
  if (/finish window/i.test(t)) return "только итог";
  if (/^Жду план$/i.test(t)) return "жду план";
  if (/^План по шаблону$/i.test(t)) return "план по шаблону";
  if (/^План:/i.test(t)) return t.replace(/^План:/i, "план:");
  if (/^finish$/i.test(t)) return "finish";
  if (/^final$/i.test(t)) return "итог";
  if (/отклон/i.test(t)) return t;
  if (/ ok$/i.test(t)) return t.replace(/ ok$/i, " · ок");
  return t;
}

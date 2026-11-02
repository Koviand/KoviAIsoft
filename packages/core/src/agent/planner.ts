import type { AgentPlanStep } from "@kovi/shared";

import { PLAN_ADVANCING_TOOLS } from "./parseAction.js";

export const PLAN_MIN_STEPS = 3;
export const PLAN_MAX_STEPS = 7;
/** Extra targeted repair before falling back to a template plan. */
export const PLAN_PHASE_MAX_ATTEMPTS = 3;

export type PlanDraftItem = { id: string; title: string };

/** Default coding checklist when the model fails to produce a plan. */
export function defaultCodingPlan(): AgentPlanStep[] {
  return [
    { id: "1", title: "Создать минимально запускаемый основной файл", status: "pending" },
    { id: "2", title: "Добавить модули / дописать логику", status: "pending" },
    { id: "3", title: "Проверить запуск (run_terminal)", status: "pending" },
    { id: "4", title: "Исправить ошибки при необходимости", status: "pending" },
    { id: "5", title: "Краткий итог пользователю (final)", status: "pending" },
  ];
}

/** Generic non-coding checklist. */
export function defaultGenericPlan(): AgentPlanStep[] {
  return [
    { id: "1", title: "Уточнить текущее состояние (list_dir / read / search)", status: "pending" },
    { id: "2", title: "Выполнить основное действие инструментом", status: "pending" },
    { id: "3", title: "Проверить результат", status: "pending" },
    { id: "4", title: "Краткий итог (final)", status: "pending" },
  ];
}

export function defaultPlanForTask(wantsFiles: boolean): AgentPlanStep[] {
  return wantsFiles ? defaultCodingPlan() : defaultGenericPlan();
}

/** Normalize model plan to 3–7 short pending steps. */
export function normalizePlanDraft(
  draft: PlanDraftItem[] | undefined | null,
  wantsFiles: boolean,
): AgentPlanStep[] | null {
  if (!draft?.length) return null;
  const cleaned: AgentPlanStep[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < draft.length && cleaned.length < PLAN_MAX_STEPS; i++) {
    const raw = draft[i]!;
    const title = String(raw.title || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
    if (!title) continue;
    let id = String(raw.id || String(cleaned.length + 1))
      .replace(/\s+/g, "")
      .slice(0, 24);
    if (!id || seen.has(id)) id = String(cleaned.length + 1);
    seen.add(id);
    cleaned.push({ id, title, status: "pending" });
  }
  if (cleaned.length < PLAN_MIN_STEPS) {
    // Pad with defaults so we always freeze a usable checklist.
    const fallback = defaultPlanForTask(wantsFiles);
    for (const f of fallback) {
      if (cleaned.length >= PLAN_MIN_STEPS) break;
      if (seen.has(f.id)) continue;
      cleaned.push({ ...f });
      seen.add(f.id);
    }
  }
  if (!cleaned.length) return null;
  return cleaned.slice(0, PLAN_MAX_STEPS);
}

export function firstPendingIndex(steps: AgentPlanStep[]): number {
  return steps.findIndex((s) => s.status === "pending");
}

export function currentPlanStep(steps: AgentPlanStep[]): AgentPlanStep | null {
  const idx = firstPendingIndex(steps);
  return idx >= 0 ? steps[idx]! : null;
}

/** Mark the first pending step done (after a successful tool). */
export function markCurrentPlanDone(
  steps: AgentPlanStep[],
  detail?: string,
): AgentPlanStep[] {
  const idx = firstPendingIndex(steps);
  if (idx < 0) return steps;
  return steps.map((s, j) =>
    j === idx ? { ...s, status: "done" as const, detail: detail || s.detail } : s,
  );
}

/**
 * Whether a successful tool should advance the current plan checklist item.
 * Avoids marking "write main file" done after an unrelated run_terminal / browser call.
 */
export function shouldAdvancePlanOnTool(
  step: AgentPlanStep | null,
  toolName: string,
  args: Record<string, unknown> = {},
): boolean {
  if (!step) return false;
  if (!PLAN_ADVANCING_TOOLS.has(toolName)) return false;

  const t = step.title.toLowerCase();
  // Avoid \\b — it does not treat Cyrillic as word chars in JS.
  const isFinalish =
    /(итог|final|finish|отчет|отчёт|резюме)/i.test(t) &&
    !(/(исправ|допис|созда|напис|файл|код)/i.test(t));
  if (isFinalish) return false;

  // Avoid matching «запускаемый» inside coding titles.
  const wantsRun =
    /(запустить|запуск(?!аем)|terminal|shell|cmd|проверь|проверить|тест|run_)/i.test(t);
  const wantsWrite =
    /(файл|созда|напис|допис|модул|логик|код|write|patch|исправ|реализ|skeleton|скелет)/i.test(
      t,
    );
  const wantsBrowse = /(браузер|browser|сайт|http|навиг|клик)/i.test(t);
  const wantsDelete = /(удал|delete)/i.test(t);

  if (wantsRun && !wantsWrite) return toolName === "run_terminal";
  if (wantsBrowse && !wantsWrite) return toolName.startsWith("browser_");
  if (wantsDelete && !wantsWrite) return toolName === "delete_path";

  if (wantsWrite) {
    if (toolName === "write_file" || toolName === "apply_patch") {
      const pathRaw = String(args.path ?? "")
        .replace(/\\/g, "/")
        .toLowerCase();
      if (pathRaw) {
        const base = pathRaw.split("/").pop() || "";
        if (base && t.includes(base)) return true;
        const parts = pathRaw.split("/").filter((p) => p.length > 2);
        if (parts.some((p) => t.includes(p))) return true;
      }
      return true;
    }
    // Shell during a coding step only advances if the step also mentions run/check.
    if (toolName === "run_terminal" && wantsRun) return true;
    return false;
  }

  // Generic / exploratory step titles: any advancing tool is OK.
  return true;
}

/** Detect soft resume / continue prompts that should keep the frozen plan. */
export function isSoftResumeGoal(freshGoal: string, previousGoal: string): boolean {
  const fresh = freshGoal.toLowerCase().trim();
  const prev = previousGoal.toLowerCase().trim();
  if (!fresh || !prev) return false;
  if (fresh === prev) return true;
  if (fresh.includes(prev.slice(0, Math.min(80, prev.length)))) return true;
  if (
    /^(продолж|докажи|добь|ещё|еще|добавь|допиши|исправ|почин|resume|continue|keep going)/i.test(
      fresh,
    )
  ) {
    return true;
  }
  // Shared significant tokens (≥4 chars) — "tetris score" after "make tetris".
  const tokenize = (s: string) =>
    s
      .split(/[^\p{L}\p{N}]+/u)
      .map((x) => x.toLowerCase())
      .filter((x) => x.length >= 4);
  const a = new Set(tokenize(prev));
  const b = tokenize(fresh);
  if (!a.size || !b.length) return false;
  const overlap = b.filter((t) => a.has(t)).length;
  return overlap >= 1 && overlap / Math.max(b.length, 1) >= 0.4;
}

/** Mark the first pending step failed (after a tool error). */
export function markCurrentPlanFailed(
  steps: AgentPlanStep[],
  detail?: string,
): AgentPlanStep[] {
  const idx = firstPendingIndex(steps);
  if (idx < 0) return steps;
  return steps.map((s, j) =>
    j === idx
      ? { ...s, status: "failed" as const, detail: detail || s.detail }
      : s,
  );
}

/** Skip remaining pending steps (on successful final). */
export function skipRemainingPlan(steps: AgentPlanStep[]): AgentPlanStep[] {
  return steps.map((s) =>
    s.status === "pending" ? { ...s, status: "skipped" as const } : s,
  );
}

export function planPhaseInstruction(wantsFiles: boolean): string {
  const hint = wantsFiles
    ? `Для кодинга ориентир пунктов: (1) минимально запускаемый файл, (2) модули/логика, (3) проверка запуска, (4) фиксы, (5) итог.`
    : `Пункты должны быть конкретными действиями с инструментами.`;
  return (
    `ФАЗА ПЛАНА (обязательно сейчас).\n` +
    `Верни строго JSON: {"thought":"…","plan":[{"id":"1","title":"…"},…],"tool":null,"final":null}.\n` +
    `Ровно ${PLAN_MIN_STEPS}–${PLAN_MAX_STEPS} коротких шагов. Без tool и без final.\n` +
    hint
  );
}

export function executePhaseHint(current: AgentPlanStep | null, plan: AgentPlanStep[]): string {
  const list = plan
    .slice(0, 12)
    .map((p) => `  [${p.status}] ${p.id}: ${p.title}`)
    .join("\n");
  if (!current) {
    return (
      `План выполнен. Можно final (краткий итог) или finish.\n` +
      `План зафиксирован — не переписывай plan.\n${list}`
    );
  }
  return (
    `ФАЗА ИСПОЛНЕНИЯ. План зафиксирован — НЕ меняй plan (поле plan опусти или повтори как есть).\n` +
    `Текущий пункт: [${current.id}] ${current.title}\n` +
    `Один tool за шаг. Затем жди результат.\n` +
    `Чеклист:\n${list}`
  );
}

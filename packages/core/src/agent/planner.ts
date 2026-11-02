import type { AgentPlanStep, AgentPlanStepKind } from "@kovi/shared";

import { PLAN_ADVANCING_TOOLS } from "./parseAction.js";

export const PLAN_MIN_STEPS = 3;
export const PLAN_MAX_STEPS = 7;
/** Extra targeted repair before falling back to a template plan. */
export const PLAN_PHASE_MAX_ATTEMPTS = 3;

/** Cursor-like agent phase. */
export type AgentPhase = "plan" | "execute" | "finish_only";

export type PlanDraftItem = {
  id: string;
  title: string;
  kind?: AgentPlanStepKind;
};

/** Infer step kind from title (fallback for models that omit kind). */
export function inferPlanStepKind(title: string): AgentPlanStepKind {
  const t = title.toLowerCase();
  if (
    /(итог|final|finish|отчет|отчёт|резюме)/i.test(t) &&
    !(/(исправ|допис|созда|напис|файл|код)/i.test(t))
  ) {
    return "finalize";
  }
  if (
    /(запустить|запуск(?!аем)|terminal|shell|cmd|проверь|проверить|тест|run_)/i.test(t)
  ) {
    return "run";
  }
  if (/(провер|verify|валид|lint|typecheck)/i.test(t)) {
    return "verify";
  }
  if (
    /(файл|созда|напис|допис|модул|логик|код|write|patch|исправ|реализ|skeleton|скелет|удал|delete)/i.test(
      t,
    )
  ) {
    return "edit";
  }
  if (
    /(уточн|развед|list|read|search|обзор|состоян|explore|найд|посмотр)/i.test(t)
  ) {
    return "explore";
  }
  return "edit";
}

const EXPLORE_TOOLS = new Set([
  "read_file",
  "list_dir",
  "search",
  "git_status",
  "git_diff",
  "git_log",
]);

export function isExploreTool(toolName: string): boolean {
  return EXPLORE_TOOLS.has(toolName) || toolName.startsWith("browser_");
}

/** Default coding checklist when the model fails to produce a plan. */
export function defaultCodingPlan(): AgentPlanStep[] {
  return [
    {
      id: "1",
      title: "Создать минимально запускаемый основной файл",
      status: "pending",
      kind: "edit",
    },
    {
      id: "2",
      title: "Добавить модули / дописать логику",
      status: "pending",
      kind: "edit",
    },
    {
      id: "3",
      title: "Проверить запуск (run_terminal)",
      status: "pending",
      kind: "run",
    },
    {
      id: "4",
      title: "Исправить ошибки при необходимости",
      status: "pending",
      kind: "edit",
    },
    {
      id: "5",
      title: "Краткий итог пользователю (final)",
      status: "pending",
      kind: "finalize",
    },
  ];
}

/** Generic non-coding checklist. */
export function defaultGenericPlan(): AgentPlanStep[] {
  return [
    {
      id: "1",
      title: "Уточнить текущее состояние (list_dir / read / search)",
      status: "pending",
      kind: "explore",
    },
    {
      id: "2",
      title: "Выполнить основное действие инструментом",
      status: "pending",
      kind: "edit",
    },
    {
      id: "3",
      title: "Проверить результат",
      status: "pending",
      kind: "verify",
    },
    {
      id: "4",
      title: "Краткий итог (final)",
      status: "pending",
      kind: "finalize",
    },
  ];
}

export function defaultPlanForTask(wantsFiles: boolean): AgentPlanStep[] {
  return wantsFiles ? defaultCodingPlan() : defaultGenericPlan();
}

function normalizeKind(raw: unknown, title: string): AgentPlanStepKind {
  const allowed: AgentPlanStepKind[] = [
    "explore",
    "edit",
    "run",
    "verify",
    "finalize",
  ];
  if (typeof raw === "string" && (allowed as string[]).includes(raw)) {
    return raw as AgentPlanStepKind;
  }
  return inferPlanStepKind(title);
}

/** Normalize model plan to 3–7 short pending steps with kind. */
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
    cleaned.push({
      id,
      title,
      status: "pending",
      kind: normalizeKind(raw.kind, title),
    });
  }
  if (cleaned.length < PLAN_MIN_STEPS) {
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

export function resolveAgentPhase(opts: {
  planFrozen: boolean;
  steps: AgentPlanStep[];
  finishOnly: boolean;
}): AgentPhase {
  if (opts.finishOnly) return "finish_only";
  if (opts.planFrozen && opts.steps.length > 0) return "execute";
  return "plan";
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
 * Prefers step.kind; falls back to title heuristics for legacy plans.
 */
export function shouldAdvancePlanOnTool(
  step: AgentPlanStep | null,
  toolName: string,
  args: Record<string, unknown> = {},
): boolean {
  if (!step) return false;

  const kind = step.kind || inferPlanStepKind(step.title);

  if (kind === "finalize") return false;

  if (kind === "explore") {
    // Explore steps advance on scout tools even if not in PLAN_ADVANCING_TOOLS.
    return isExploreTool(toolName) || PLAN_ADVANCING_TOOLS.has(toolName);
  }

  if (!PLAN_ADVANCING_TOOLS.has(toolName)) return false;

  if (kind === "run" || kind === "verify") {
    return toolName === "run_terminal" || toolName.startsWith("browser_");
  }

  if (kind === "edit") {
    if (toolName === "write_file" || toolName === "apply_patch") {
      const t = step.title.toLowerCase();
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
    if (toolName === "delete_path") return true;
    return false;
  }

  return true;
}

/**
 * Soft resume: keep frozen unfinished plan only on exact goal match
 * or a short continuation cue (no token-overlap guessing).
 */
export function isSoftResumeGoal(
  freshGoal: string,
  previousGoal: string,
  opts?: { hasUnfinishedFrozenPlan?: boolean },
): boolean {
  const fresh = freshGoal.toLowerCase().trim();
  const prev = previousGoal.toLowerCase().trim();
  if (!fresh || !prev) return false;
  if (fresh === prev) return true;

  const continueCue =
    /^(продолж|докажи|добь|ещё|еще|добавь|допиши|исправ|почин|resume|continue|keep going)/i.test(
      fresh,
    );
  if (!continueCue) return false;
  // Continue cues require an unfinished frozen plan.
  return opts?.hasUnfinishedFrozenPlan === true;
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

/** Soft-skip the current pending step (stuck run/verify) and continue. */
export function skipCurrentPlanStep(
  steps: AgentPlanStep[],
  detail?: string,
): AgentPlanStep[] {
  const idx = firstPendingIndex(steps);
  if (idx < 0) return steps;
  return steps.map((s, j) =>
    j === idx
      ? { ...s, status: "skipped" as const, detail: detail || s.detail || "soft-skip" }
      : s,
  );
}

export function stepKindOf(step: AgentPlanStep | null): AgentPlanStepKind | null {
  if (!step) return null;
  return step.kind || inferPlanStepKind(step.title);
}

/** Skip remaining pending steps (on successful final). */
export function skipRemainingPlan(steps: AgentPlanStep[]): AgentPlanStep[] {
  return steps.map((s) =>
    s.status === "pending" ? { ...s, status: "skipped" as const } : s,
  );
}

export function planPhaseInstruction(wantsFiles: boolean): string {
  const hint = wantsFiles
    ? `Кодинг: edit → edit → run → edit(fix) → finalize. У каждого шага kind: explore|edit|run|verify|finalize.`
    : `Шаги — конкретные действия. Укажи kind у каждого пункта.`;
  return (
    `ФАЗА ПЛАНА.\n` +
    `Верни ТОЛЬКО JSON: {"thought":"…","plan":[{"id":"1","title":"…","kind":"edit"},…],"tool":null,"final":null}.\n` +
    `Ровно ${PLAN_MIN_STEPS}–${PLAN_MAX_STEPS} шагов. Инструменты сейчас ЗАПРЕЩЕНЫ.\n` +
    hint
  );
}

export function executePhaseHint(current: AgentPlanStep | null, plan: AgentPlanStep[]): string {
  const list = plan
    .slice(0, 12)
    .map((p) => `  [${p.status}] ${p.id}${p.kind ? `(${p.kind})` : ""}: ${p.title}`)
    .join("\n");
  if (!current) {
    return (
      `План выполнен. Верни final или finish.\n` +
      `План зафиксирован — не переписывай plan.\n${list}`
    );
  }
  const kind = current.kind || inferPlanStepKind(current.title);
  const toolHint =
    kind === "edit"
      ? "Нужен write_file / apply_patch."
      : kind === "run" || kind === "verify"
        ? "Нужен run_terminal (или browser_*)."
        : kind === "explore"
          ? "Нужен read_file / list_dir / search."
          : kind === "finalize"
            ? "Можно final или finish."
            : "Один tool под текущий пункт.";
  return (
    `ФАЗА ИСПОЛНЕНИЯ. План зафиксирован — НЕ меняй plan.\n` +
    `Текущий: [${current.id}] (${kind}) ${current.title}\n` +
    `${toolHint} Один tool за шаг.\n` +
    `Чеклист:\n${list}`
  );
}

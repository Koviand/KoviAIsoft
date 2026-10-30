import type { AgentPlanStep } from "@kovi/shared";

/** Sticky agent state that survives transcript condense / emergency shrink. */
export interface AgentWorkingMemory {
  goal: string;
  plan: Array<{ id: string; title: string; status: string }>;
  /** After plan phase, titles/ids are frozen; only statuses update. */
  planFrozen?: boolean;
  filesTouched: string[];
  lastTool: string | null;
  lastResult: string | null;
  lastError: string | null;
  notes: string[];
}

export const WM_MARKER = "# Working memory (не забывай)";

export function createWorkingMemory(goal: string): AgentWorkingMemory {
  return {
    goal: goal.replace(/\s+/g, " ").trim().slice(0, 400),
    plan: [],
    planFrozen: false,
    filesTouched: [],
    lastTool: null,
    lastResult: null,
    lastError: null,
    notes: [],
  };
}

export function formatWorkingMemory(wm: AgentWorkingMemory): string {
  const lines: string[] = [WM_MARKER, `goal: ${wm.goal || "(не задано)"}`];
  if (wm.plan.length) {
    lines.push(`plan${wm.planFrozen ? " (зафиксирован)" : " (черновик)"}:`);
    for (const p of wm.plan.slice(0, 12)) {
      lines.push(`  - [${p.status}] ${p.id}: ${p.title}`);
    }
    const next = wm.plan.find((p) => p.status === "pending");
    if (next && wm.planFrozen) {
      lines.push(`current_step: ${next.id} — ${next.title}`);
    }
  }
  if (wm.filesTouched.length) {
    lines.push(`files: ${wm.filesTouched.slice(-16).join(", ")}`);
  }
  if (wm.lastTool) {
    lines.push(`last_tool: ${wm.lastTool}`);
  }
  if (wm.lastResult) {
    lines.push(`last_result: ${wm.lastResult}`);
  }
  if (wm.lastError) {
    lines.push(`last_error: ${wm.lastError}`);
  }
  if (wm.notes.length) {
    lines.push("notes:");
    for (const n of wm.notes.slice(-8)) lines.push(`  - ${n}`);
  }
  lines.push(
    wm.planFrozen
      ? "Правило: план зафиксирован — выполняй current_step одним tool; не переписывай plan; не повторяй сделанное."
      : "Правило: сначала составь plan (3–7 шагов), без tool/final; после фиксации плана — исполнение.",
  );
  return lines.join("\n");
}

/** Strip previous working-memory block and append a fresh one. */
export function applyWorkingMemoryToSystem(
  systemPrompt: string,
  wm: AgentWorkingMemory,
): string {
  const base = systemPrompt.includes(WM_MARKER)
    ? systemPrompt.slice(0, systemPrompt.indexOf(WM_MARKER)).trimEnd()
    : systemPrompt.trimEnd();
  return `${base}\n\n${formatWorkingMemory(wm)}`;
}

export function extractWorkingMemoryBlock(systemContent: string): string | null {
  const idx = systemContent.indexOf(WM_MARKER);
  if (idx < 0) return null;
  return systemContent.slice(idx).trim();
}

/**
 * Truncate system prompt but always keep the Working memory block at the end.
 */
export function truncateSystemPreservingWm(
  systemContent: string,
  maxTokens: number,
  truncateFn: (text: string, maxTokens: number) => string,
  estimateFn: (text: string) => number,
): string {
  if (estimateFn(systemContent) <= maxTokens) return systemContent;
  const wm = extractWorkingMemoryBlock(systemContent);
  if (!wm) return truncateFn(systemContent, maxTokens);
  const wmTokens = estimateFn(wm) + 8;
  if (wmTokens >= maxTokens) {
    return truncateFn(wm, maxTokens);
  }
  const headBudget = Math.max(64, maxTokens - wmTokens);
  const head = systemContent.includes(WM_MARKER)
    ? systemContent.slice(0, systemContent.indexOf(WM_MARKER)).trimEnd()
    : systemContent;
  const trimmedHead = truncateFn(head, headBudget);
  return `${trimmedHead}\n\n${wm}`;
}

export function serializeWorkingMemory(wm: AgentWorkingMemory): string {
  return JSON.stringify(wm);
}

export function parseWorkingMemory(raw: unknown): AgentWorkingMemory | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const j = JSON.parse(raw) as AgentWorkingMemory;
    if (!j || typeof j.goal !== "string") return null;
    const plan = Array.isArray(j.plan) ? j.plan : [];
    return {
      goal: j.goal,
      plan,
      planFrozen:
        typeof j.planFrozen === "boolean"
          ? j.planFrozen
          : // Legacy scratchpads with a plan were already mid-run — treat as frozen.
            plan.length > 0,
      filesTouched: Array.isArray(j.filesTouched) ? j.filesTouched : [],
      lastTool: j.lastTool ?? null,
      lastResult: j.lastResult ?? null,
      lastError: j.lastError ?? null,
      notes: Array.isArray(j.notes) ? j.notes : [],
    };
  } catch {
    return null;
  }
}

export function updatePlanMemory(
  wm: AgentWorkingMemory,
  steps: AgentPlanStep[],
): void {
  if (!steps.length) return;
  wm.plan = steps.map((s) => ({
    id: s.id,
    title: s.title,
    status: s.status,
  }));
}

export function rememberToolSuccess(
  wm: AgentWorkingMemory,
  toolName: string,
  args: Record<string, unknown>,
  result: string,
): void {
  wm.lastTool = toolName;
  wm.lastError = null;
  const path =
    typeof args.path === "string"
      ? args.path
      : typeof args.cwd === "string"
        ? args.cwd
        : null;
  if (path && (toolName === "write_file" || toolName === "apply_patch" || toolName === "read_file")) {
    if (!wm.filesTouched.includes(path)) wm.filesTouched.push(path);
  }
  const compact = result.replace(/\s+/g, " ").trim().slice(0, 180);
  wm.lastResult = compact;
  if (toolName === "write_file" && path) {
    wm.notes.push(`wrote ${path}`);
  } else if (toolName === "run_terminal") {
    const cmd = String(args.command ?? "").slice(0, 80);
    wm.notes.push(`shell: ${cmd}`);
  }
  if (wm.notes.length > 12) wm.notes = wm.notes.slice(-12);
}

export function rememberToolError(
  wm: AgentWorkingMemory,
  toolName: string,
  message: string,
): void {
  wm.lastTool = toolName;
  wm.lastError = message.replace(/\s+/g, " ").trim().slice(0, 220);
  wm.notes.push(`error ${toolName}: ${wm.lastError}`);
  if (wm.notes.length > 12) wm.notes = wm.notes.slice(-12);
}

/**
 * Emergency shrink that keeps system (with working memory) + optional summary + recent tail.
 */
export function emergencyShrinkTranscript<T extends { role: string; content: string }>(
  transcript: T[],
  keepRecent: number,
  summarize?: (old: T[]) => string,
): T[] {
  if (transcript.length <= keepRecent + 1) return transcript;
  const system = transcript[0]?.role === "system" ? transcript[0] : null;
  const rest = system ? transcript.slice(1) : transcript.slice();
  const recent = rest.slice(-Math.max(1, keepRecent));
  const dropped = rest.slice(0, Math.max(0, rest.length - keepRecent));
  const parts: T[] = [];
  if (system) parts.push(system);
  if (summarize && dropped.length) {
    const summary = summarize(dropped);
    if (summary.trim()) {
      parts.push({ role: "user", content: summary } as T);
    }
  }
  parts.push(...recent);
  return parts;
}

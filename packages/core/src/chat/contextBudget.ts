/** Rough token estimate for mixed RU/EN prompts (llama BPE-ish). */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii += 1;
    else other += 1;
  }
  // ASCII ~4 chars/token, Cyrillic/other ~2 chars/token; +overhead per message later.
  return Math.ceil(ascii / 4 + other / 2);
}

export function estimateMessagesTokens(
  messages: Array<{ content: string }>,
): number {
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(m.content) + 8;
  }
  return total;
}

export function truncateToTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  // Over-approximate chars from token budget.
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const slice = text.slice(text.length - mid);
    if (estimateTokens(slice) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  const kept = text.slice(text.length - lo);
  return lo < text.length ? `…[обрезано]\n${kept}` : kept;
}

/**
 * Fit chat/agent messages into context: keep system (trimmed) + newest turns.
 * `reserveCompletion` leaves room for max_tokens.
 */
export function fitMessagesToContext<T extends { role: string; content: string }>(
  messages: T[],
  contextTokens: number,
  reserveCompletion: number,
): T[] {
  if (!messages.length) return messages;
  const budget = Math.max(256, contextTokens - Math.max(64, reserveCompletion) - 32);

  const out = messages.map((m) => ({ ...m }));
  const systemIdx = out.findIndex((m) => m.role === "system");
  let system = systemIdx >= 0 ? out[systemIdx]! : null;
  const rest = out.filter((_, i) => i !== systemIdx);

  const systemBudget = Math.floor(budget * 0.35);
  if (system && estimateTokens(system.content) > systemBudget) {
    system = {
      ...system,
      content: truncateToTokens(system.content, systemBudget),
    };
  }

  let used = system ? estimateTokens(system.content) + 8 : 0;
  const keptRev: T[] = [];

  for (let i = rest.length - 1; i >= 0; i--) {
    const msg = rest[i]!;
    const cost = estimateTokens(msg.content) + 8;
    if (keptRev.length === 0) {
      // Always keep the newest message; truncate if needed.
      const room = Math.max(64, budget - used);
      if (cost > room) {
        keptRev.push({ ...msg, content: truncateToTokens(msg.content, room) });
        used = budget;
      } else {
        keptRev.push(msg);
        used += cost;
      }
      continue;
    }
    if (used + cost > budget) break;
    keptRev.push(msg);
    used += cost;
  }

  const kept = keptRev.reverse();
  return system ? [system, ...kept] : kept;
}

export function isContextOverflowError(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err);
  return /exceed_context_size|exceeds the available context|n_prompt_tokens/i.test(raw);
}

/**
 * Completion (max_tokens) budgets — allow long answers when the context window allows
 * (Cursor-like), instead of a fixed 2–4k hard cap.
 */

export type CompletionTier = "fast" | "balanced" | "quality";

/** Suggested default max_tokens for profiles / «Под этот ПК». */
export function suggestedMaxTokens(
  context: number,
  tier: CompletionTier = "balanced",
): number {
  const ctx = Math.max(512, context);
  if (tier === "fast") {
    return Math.max(1024, Math.min(4096, Math.floor(ctx * 0.4)));
  }
  if (tier === "quality") {
    return Math.max(2048, Math.min(12288, Math.floor(ctx * 0.55)));
  }
  // balanced: half the window, up to 8k
  return Math.max(2048, Math.min(8192, Math.floor(ctx * 0.5)));
}

/**
 * Honor requested maxTokens up to what still leaves room for the prompt.
 * Default: keep ~30% of context for history/system (so 16k ctx → ~11k reply).
 */
export function clampCompletionTokens(
  context: number,
  requested: number,
  opts?: {
    min?: number;
    /** Fraction of context reserved for prompt (0–0.7). Default 0.3. */
    promptReserveRatio?: number;
    /** Absolute floor for prompt reserve tokens. */
    minPromptReserve?: number;
  },
): number {
  const ctx = Math.max(512, context || 4096);
  const minOut = opts?.min ?? 256;
  const reserveRatio = Math.min(0.7, Math.max(0.15, opts?.promptReserveRatio ?? 0.3));
  const reserve = Math.max(opts?.minPromptReserve ?? 1024, Math.floor(ctx * reserveRatio));
  const hardCap = Math.max(minOut, ctx - reserve);
  const want = Math.max(minOut, requested > 0 ? requested : suggestedMaxTokens(ctx));
  return Math.min(want, hardCap);
}

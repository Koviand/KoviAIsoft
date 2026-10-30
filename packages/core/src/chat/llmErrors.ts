/** Soft failure: completion hit max_tokens — agent loop should nudge and continue. */
export class LlmTruncatedError extends Error {
  readonly truncated = true as const;
  constructor(message?: string) {
    super(
      message ||
        "Ответ LLM обрезан по max_tokens (finish_reason=length). Разбейте код на несколько write_file или увеличьте maxTokens/context.",
    );
    this.name = "LlmTruncatedError";
  }
}

export function isLlmTruncatedError(err: unknown): boolean {
  return (
    err instanceof LlmTruncatedError ||
    (err instanceof Error &&
      (/finish_reason=length|обрезан по max_tokens|LlmTruncatedError/i.test(err.message) ||
        err.name === "LlmTruncatedError"))
  );
}

/** Map opaque Node/Electron fetch failures to actionable Russian errors. */
export function formatLlmFetchError(err: unknown, baseUrl: string | null): Error {
  if (err instanceof Error && err.name === "AbortError") {
    return new Error("Отменено");
  }
  if (isLlmTruncatedError(err)) {
    return err instanceof Error ? err : new LlmTruncatedError(String(err));
  }
  const raw = err instanceof Error ? err.message : String(err);
  // Keep our own already-localized diagnostics.
  if (
    /Нет связи с локальной моделью|Модель не загружена|llama-server не отвечает|Ответ LLM обрезан/i.test(
      raw,
    )
  ) {
    return err instanceof Error ? err : new Error(raw);
  }
  const cause =
    err instanceof Error && "cause" in err && err.cause instanceof Error
      ? err.cause.message
      : err instanceof Error && "cause" in err && err.cause
        ? String(err.cause)
        : "";
  const blob = `${raw} ${cause}`.toLowerCase();

  if (
    blob.includes("fetch failed") ||
    blob.includes("econnrefused") ||
    blob.includes("econnreset") ||
    blob.includes("enotfound") ||
    blob.includes("network") ||
    blob.includes("socket hang up") ||
    blob.includes("econnaborted")
  ) {
    const detail = cause && cause !== raw ? ` (${cause})` : "";
    return new Error(
      `Нет связи с локальной моделью${baseUrl ? ` (${baseUrl})` : ""}${detail}. ` +
        `Загрузите модель: «Модели» → «Загрузить в память». ` +
        `Если модель уже загружена — перезагрузите её (сервер мог упасть или был перегружен длинным запросом).`,
    );
  }
  if (
    blob.includes("exceed_context_size") ||
    blob.includes("exceeds the available context") ||
    blob.includes("n_prompt_tokens")
  ) {
    return new Error(
      "Промпт не влезает в context окна модели. Создайте новый диалог или увеличьте context в профиле загрузки / параметрах сессии. История агента обрезается автоматически — повторите запрос.",
    );
  }
  // User cancel / AbortController — never mislabel as timeout (P1-22).
  if (
    blob.includes("отмен") ||
    /\babort(ed|error)?\b/.test(blob) ||
    (err instanceof Error && err.name === "AbortError")
  ) {
    return new Error("Отменено");
  }
  if (blob.includes("timeout") || blob.includes("timed out") || blob.includes("etimedout")) {
    return new Error(
      "Таймаут ответа модели. Уменьшите max tokens / context или проверьте, что GPU не перегружен.",
    );
  }
  return err instanceof Error ? err : new Error(raw);
}

/**
 * Remove LFM/Qwen-style &lt;think&gt; / &lt;thinking&gt; blocks so agent JSON parse is not polluted.
 */
export function stripThinkTags(text: string): string {
  if (!text) return text;
  return text
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking\b[^>]*>[\s\S]*?<\/thinking>/gi, "")
    .replace(/<\/?(?:think|thinking)\b[^>]*>/gi, "")
    .trim();
}

/** Extract assistant text from OpenAI-compatible chat completion payloads (LFM puts JSON in reasoning). */
export function pickCompletionText(message: {
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
  text?: string | null;
} | null | undefined): string {
  if (!message) return "";
  if (typeof message.content === "string" && message.content.trim()) {
    return stripThinkTags(message.content);
  }
  if (typeof message.reasoning_content === "string" && message.reasoning_content.trim()) {
    return stripThinkTags(message.reasoning_content);
  }
  if (typeof message.reasoning === "string" && message.reasoning.trim()) {
    return stripThinkTags(message.reasoning);
  }
  if (typeof message.text === "string") return stripThinkTags(message.text);
  return "";
}

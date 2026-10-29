import { describe, expect, it } from "vitest";
import {
  formatLlmFetchError,
  pickCompletionText,
} from "../packages/core/src/chat/llmErrors";

describe("formatLlmFetchError", () => {
  it("maps fetch failed to Russian actionable text", () => {
    const err = formatLlmFetchError(new Error("fetch failed"), "http://127.0.0.1:8080/v1");
    expect(err.message).toMatch(/Нет связи с локальной моделью/);
    expect(err.message).toMatch(/Загрузить в память/);
  });

  it("preserves already-localized assertLlmReady errors", () => {
    const raw = new Error("Нет связи с локальной моделью (порт 8080): boom. Runtime: x");
    expect(formatLlmFetchError(raw, "http://127.0.0.1:8080/v1").message).toBe(raw.message);
  });

  it("maps AbortError to Отменено", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(formatLlmFetchError(abort, null).message).toBe("Отменено");
  });
});

describe("pickCompletionText", () => {
  it("falls back to reasoning_content when content empty (LFM)", () => {
    expect(
      pickCompletionText({
        content: "",
        reasoning_content: '{"tool":{"name":"list_dir"}}',
      }),
    ).toContain("list_dir");
    expect(pickCompletionText({ content: "  hi  " }).trim()).toBe("hi");
  });
});

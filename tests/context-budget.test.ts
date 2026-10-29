import { describe, expect, it } from "vitest";
import {
  estimateTokens,
  fitMessagesToContext,
  isContextOverflowError,
} from "../packages/core/src/chat/contextBudget";

describe("contextBudget", () => {
  it("estimates tokens for ascii vs cyrillic", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("привет")).toBeGreaterThan(estimateTokens("privet"));
  });

  it("keeps system and newest messages under budget", () => {
    const msgs = [
      { role: "system", content: "sys " + "x".repeat(2000) },
      { role: "user", content: "old-1 " + "a".repeat(4000) },
      { role: "assistant", content: "old-2 " + "b".repeat(4000) },
      { role: "user", content: "newest question" },
    ];
    const fitted = fitMessagesToContext(msgs, 1024, 256);
    expect(fitted[0]?.role).toBe("system");
    expect(fitted[fitted.length - 1]?.content).toContain("newest");
    // Oldest bulk turns should be dropped or truncated enough to fit.
    const joined = fitted.map((m) => m.content).join("\n");
    expect(joined.length).toBeLessThan(msgs.map((m) => m.content).join("\n").length);
  });

  it("detects llama context overflow payloads", () => {
    expect(
      isContextOverflowError(
        new Error(
          'Ошибка LLM: 400 {"error":{"type":"exceed_context_size_error","n_prompt_tokens":8219,"n_ctx":8192}}',
        ),
      ),
    ).toBe(true);
    expect(isContextOverflowError(new Error("fetch failed"))).toBe(false);
  });
});

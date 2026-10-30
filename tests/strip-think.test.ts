import { describe, expect, it } from "vitest";
import { pickCompletionText, stripThinkTags } from "../packages/core/src/chat/llmErrors";

describe("stripThinkTags", () => {
  it("removes think blocks and leaves JSON", () => {
    const raw = `<think>plan...</think>\n{"type":"final","content":"ok"}`;
    expect(stripThinkTags(raw)).toBe('{"type":"final","content":"ok"}');
  });

  it("pickCompletionText strips think from content", () => {
    expect(
      pickCompletionText({
        content: `<thinking>x</thinking>{"type":"tool","name":"write_file"}`,
      }),
    ).toBe('{"type":"tool","name":"write_file"}');
  });
});

import { describe, expect, it } from "vitest";
import {
  clampCompletionTokens,
  suggestedMaxTokens,
} from "../packages/core/src/chat/completionBudget";

describe("suggestedMaxTokens", () => {
  it("scales with context and tier", () => {
    expect(suggestedMaxTokens(4096, "fast")).toBe(1638); // floor(4096*0.4)
    expect(suggestedMaxTokens(8192, "balanced")).toBe(4096);
    expect(suggestedMaxTokens(16384, "balanced")).toBe(8192);
    expect(suggestedMaxTokens(16384, "quality")).toBe(9011); // floor(16384*0.55)
  });

  it("allows large answers on big windows (no 4k hard cap)", () => {
    expect(suggestedMaxTokens(16384, "quality")).toBeGreaterThan(4096);
    expect(suggestedMaxTokens(8192, "balanced")).toBeGreaterThanOrEqual(4096);
  });
});

describe("clampCompletionTokens", () => {
  it("honors request up to ~70% of context", () => {
    // 16k ctx, 30% reserve → hardCap 11468
    expect(clampCompletionTokens(16384, 10000)).toBe(10000);
    expect(clampCompletionTokens(16384, 20000)).toBe(16384 - Math.max(1024, Math.floor(16384 * 0.3)));
  });

  it("no longer hard-caps chat at 4096", () => {
    const hard8k = 8192 - Math.max(1024, Math.floor(8192 * 0.3)); // 5735
    expect(hard8k).toBeGreaterThan(4096);
    expect(clampCompletionTokens(8192, 5000)).toBe(5000);
    expect(clampCompletionTokens(8192, 9000)).toBe(hard8k);
  });

  it("keeps a floor for tiny requests", () => {
    expect(clampCompletionTokens(8192, 0, { min: 256 })).toBeGreaterThanOrEqual(256);
  });
});

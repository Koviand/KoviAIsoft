import { describe, expect, it } from "vitest";
import { shouldConfirmRisk } from "../packages/core/src/tools/sandbox.js";

describe("agent risk modes", () => {
  it("ask confirms medium and high", () => {
    expect(shouldConfirmRisk("medium", "ask", { path: "C:\\proj\\a.txt" }, "C:\\proj")).toBe(true);
    expect(shouldConfirmRisk("high", "ask", { command: "echo" }, null)).toBe(true);
    expect(shouldConfirmRisk("low", "ask", {}, null)).toBe(false);
  });

  it("auto-safe skips medium inside project", () => {
    expect(
      shouldConfirmRisk("medium", "auto-safe", { path: "C:\\proj\\a.txt" }, "C:\\proj"),
    ).toBe(false);
    expect(
      shouldConfirmRisk("medium", "auto-safe", { path: "C:\\other\\a.txt" }, "C:\\proj"),
    ).toBe(true);
    expect(shouldConfirmRisk("high", "auto-safe", { command: "rm" }, "C:\\proj")).toBe(true);
  });

  it("full only blocks dangerous system writes", () => {
    expect(shouldConfirmRisk("high", "full", { command: "echo hi" }, null)).toBe(false);
    expect(
      shouldConfirmRisk("high", "full", { path: "C:\\Windows\\System32\\x.dll" }, null),
    ).toBe(true);
  });
});

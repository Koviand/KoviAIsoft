import { describe, expect, it } from "vitest";
import { shouldConfirmRisk } from "../packages/core/src/tools/sandbox.js";

describe("agent risk modes", () => {
  it("ask confirms medium and high", () => {
    expect(shouldConfirmRisk("medium", "ask", { path: "C:\\proj\\a.txt" }, "C:\\proj")).toBe(true);
    expect(shouldConfirmRisk("high", "ask", { command: "echo" }, null, "run_terminal")).toBe(true);
    expect(shouldConfirmRisk("low", "ask", {}, null)).toBe(false);
  });

  it("auto-safe skips medium inside project but always confirms shell/delete", () => {
    expect(
      shouldConfirmRisk("medium", "auto-safe", { path: "C:\\proj\\a.txt" }, "C:\\proj", "write_file"),
    ).toBe(false);
    expect(
      shouldConfirmRisk("medium", "auto-safe", { path: "C:\\other\\a.txt" }, "C:\\proj", "write_file"),
    ).toBe(true);
    expect(
      shouldConfirmRisk("high", "auto-safe", { command: "rm" }, "C:\\proj", "run_terminal"),
    ).toBe(true);
    expect(
      shouldConfirmRisk("medium", "auto-safe", { path: "C:\\proj\\a.txt" }, "C:\\proj", "delete_path"),
    ).toBe(true);
  });

  it("full still confirms shell and dangerous system paths", () => {
    expect(
      shouldConfirmRisk("high", "full", { command: "echo hi" }, null, "run_terminal"),
    ).toBe(true);
    expect(
      shouldConfirmRisk("high", "full", { path: "C:\\Windows\\System32\\x.dll" }, null, "write_file"),
    ).toBe(true);
    expect(
      shouldConfirmRisk("medium", "full", { path: "C:\\proj\\a.txt" }, "C:\\proj", "write_file"),
    ).toBe(false);
  });
});

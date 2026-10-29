import { describe, expect, it } from "vitest";
import { isRipgrepNoMatch } from "../packages/core/src/tools/files";

describe("ripgrep no-match", () => {
  it("treats exit code 1 as empty result", () => {
    expect(isRipgrepNoMatch({ code: 1, stdout: "" })).toBe(true);
    expect(isRipgrepNoMatch({ status: 1 })).toBe(true);
  });

  it("does not treat missing binary / other errors as no-match", () => {
    expect(isRipgrepNoMatch({ code: "ENOENT" })).toBe(false);
    expect(isRipgrepNoMatch({ code: 2 })).toBe(false);
    expect(isRipgrepNoMatch(null)).toBe(false);
  });
});

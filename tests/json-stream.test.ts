import { describe, expect, it } from "vitest";
import {
  balancedJsonPrefix,
  looksBrokenJson,
  preferBalancedJson,
} from "../packages/core/src/chat/jsonStream";

describe("balancedJsonPrefix", () => {
  it("returns empty until object closes", () => {
    expect(balancedJsonPrefix('{"thought":"hi"')).toBe("");
    expect(balancedJsonPrefix('{"a":1}')).toBe('{"a":1}');
  });

  it("ignores braces inside strings", () => {
    const s = '{"thought":"use { and } carefully","tool":null,"final":null}';
    expect(balancedJsonPrefix(s)).toBe(s);
  });
});

describe("looksBrokenJson / preferBalancedJson", () => {
  it("detects truncated tail", () => {
    expect(looksBrokenJson('{"tool":{"name":"write_file","args":{"content":"x')).toBe(true);
  });

  it("prefers complete object when trailing garbage exists", () => {
    const ok = '{"thought":"ok","tool":null,"final":"done"}';
    expect(preferBalancedJson(`${ok} trailing`)).toBe(ok);
  });
});

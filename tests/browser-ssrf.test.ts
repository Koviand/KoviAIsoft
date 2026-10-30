import { describe, expect, it } from "vitest";
import { assertSafeNavigateUrl } from "../packages/core/src/tools/browser";

describe("browser SSRF guard", () => {
  it("blocks localhost and private IPs", async () => {
    await expect(assertSafeNavigateUrl("http://127.0.0.1/")).rejects.toThrow(/приватн|локальн/i);
    await expect(assertSafeNavigateUrl("http://localhost/")).rejects.toThrow(/локальн/i);
    await expect(assertSafeNavigateUrl("http://192.168.1.1/")).rejects.toThrow(/приватн/i);
    await expect(assertSafeNavigateUrl("http://169.254.169.254/latest")).rejects.toThrow(
      /приватн/i,
    );
  });

  it("allows public https hosts", async () => {
    const u = await assertSafeNavigateUrl("https://example.com/path");
    expect(u.hostname).toBe("example.com");
  });
});

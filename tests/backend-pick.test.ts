import { describe, expect, it } from "vitest";
import { pickBackend } from "../packages/core/src/system/detect";

describe("pickBackend", () => {
  it("prefers cuda then vulkan then cpu", () => {
    expect(pickBackend({ hasNvidia: true, hasVulkan: true })).toBe("cuda");
    expect(pickBackend({ hasNvidia: false, hasVulkan: true })).toBe("vulkan");
    expect(pickBackend({ hasNvidia: false, hasVulkan: false })).toBe("cpu");
  });

  it("honors explicit preference", () => {
    expect(pickBackend({ hasNvidia: true, hasVulkan: true, preference: "cpu" })).toBe("cpu");
  });
});

import { describe, expect, it } from "vitest";
import {
  isNewerRuntime,
  parseBuildNumber,
  selectAssetFromRelease,
} from "../packages/core/src/runtime/assets";

describe("runtime assets", () => {
  it("parses build numbers", () => {
    expect(parseBuildNumber("b11960")).toBe(11960);
    expect(parseBuildNumber("bad")).toBe(0);
  });

  it("selects cuda asset with cudart", () => {
    const asset = selectAssetFromRelease(
      {
        tag_name: "b12000",
        assets: [
          {
            name: "llama-b12000-bin-win-cuda-12.4-x64.zip",
            browser_download_url: "https://example/cuda.zip",
            digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          },
          {
            name: "cudart-llama-bin-win-cuda-12.4-x64.zip",
            browser_download_url: "https://example/cudart.zip",
            digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          },
        ],
      },
      "cuda",
      "12.4",
    );
    expect(asset?.assetName).toContain("cuda-12.4");
    expect(asset?.cudartAssetName).toContain("cudart");
    expect(asset?.sha256).toHaveLength(64);
  });

  it("selects vulkan asset", () => {
    const asset = selectAssetFromRelease(
      {
        tag_name: "b12000",
        assets: [
          {
            name: "llama-b12000-bin-win-vulkan-x64.zip",
            browser_download_url: "https://example/vulkan.zip",
          },
        ],
      },
      "vulkan",
    );
    expect(asset?.backend).toBe("vulkan");
  });

  it("detects newer runtime tags", () => {
    expect(isNewerRuntime("b12000", null)).toBe(true);
    expect(isNewerRuntime("b12000", "b11960")).toBe(true);
    expect(isNewerRuntime("b11960", "b11960")).toBe(false);
    expect(isNewerRuntime("b11900", "b11960")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  BUILTIN_TOOL_NAMES,
  BUILTIN_TOOL_SPECS,
  CORE_TOOL_NAMES,
  toolNamesForMode,
  toolsPromptBlock,
} from "../packages/core/src/agent/toolsCatalog";
import { buildOpenAiTools } from "../packages/core/src/agent/actionSchema";

describe("tools catalog", () => {
  it("includes delete_path aligned with agent loop", () => {
    expect(BUILTIN_TOOL_NAMES.has("delete_path")).toBe(true);
    expect(BUILTIN_TOOL_SPECS.some((t) => t.name === "delete_path")).toBe(true);
  });

  it("lists core file tools", () => {
    for (const name of [
      "list_dir",
      "read_file",
      "write_file",
      "apply_patch",
      "search",
      "run_terminal",
      "finish",
    ]) {
      expect(BUILTIN_TOOL_NAMES.has(name)).toBe(true);
    }
  });

  it("compact prompt and OpenAI tools stay aligned (CORE + MCP)", () => {
    const mcp = [{ name: "mcp_demo", description: "demo" }];
    const prompt = toolsPromptBlock(mcp, { compact: true });
    const promptNames = [...prompt.matchAll(/^- (\S+):/gm)].map((m) => m[1]!);
    const openAiNames = buildOpenAiTools({
      compact: true,
      extraTools: mcp,
    }).map((t) => t.function.name);
    expect(new Set(promptNames)).toEqual(new Set(openAiNames));
    expect(promptNames).toContain("mcp_demo");
    expect(promptNames).not.toContain("delete_path");
    expect(toolNamesForMode(["mcp_demo"], { compact: true })).toEqual(
      expect.arrayContaining([...CORE_TOOL_NAMES, "mcp_demo"]),
    );
  });
});

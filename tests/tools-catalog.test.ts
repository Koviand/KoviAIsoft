import { describe, expect, it } from "vitest";
import {
  BUILTIN_TOOL_NAMES,
  BUILTIN_TOOL_SPECS,
} from "../packages/core/src/agent/toolsCatalog";

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
});

import { describe, expect, it } from "vitest";
import {
  parseAgentAction,
  sanitizeJsonCandidate,
  validateToolArgs,
} from "../packages/core/src/agent/parseAction";
import {
  buildAgentActionJsonSchema,
  nextConstraintModeAfterFailure,
  pickConstraintMode,
} from "../packages/core/src/agent/actionSchema";
import { BUILTIN_TOOL_SPECS } from "../packages/core/src/agent/toolsCatalog";

describe("parseAgentAction", () => {
  it("parses fenced JSON", () => {
    const raw = '```json\n{"thought":"t","tool":null,"final":"hi"}\n```';
    expect(parseAgentAction(raw)?.final).toBe("hi");
  });

  it("parses with trailing comma via sanitize", () => {
    const raw = '{"thought":"ok","tool":null,"final":"done",}';
    expect(parseAgentAction(raw)?.final).toBe("done");
  });

  it("strips think tags", () => {
    const raw =
      '<think>nope</think>\n{"thought":"yes","tool":{"name":"list_dir","args":{"path":"."}},"final":null}';
    expect(parseAgentAction(raw)?.tool?.name).toBe("list_dir");
  });

  it("returns null for prose", () => {
    expect(parseAgentAction("I will help you")).toBeNull();
  });

  it("rejects empty JSON object", () => {
    expect(parseAgentAction('{"foo":1}')).toBeNull();
  });

  it("parses Hermes tool_call", () => {
    const raw = `<tool_call>
<tool_name>list_dir</tool_name>
<arguments>{"path":"."}</arguments>
</tool_call>`;
    expect(parseAgentAction(raw)?.tool?.name).toBe("list_dir");
  });

  it("sanitize smart quotes", () => {
    const s = sanitizeJsonCandidate("{“thought”: “x”}");
    expect(s).toContain('"thought"');
  });
});

describe("validateToolArgs", () => {
  it("requires write_file path+content", () => {
    const bad = validateToolArgs("write_file", { path: "a.py" });
    expect(bad.ok).toBe(false);
    const good = validateToolArgs("write_file", { path: "a.py", content: "print(1)" });
    expect(good.ok).toBe(true);
  });

  it("allows MCP-like unknown tools", () => {
    expect(validateToolArgs("mcp_foo", { x: 1 }).ok).toBe(true);
  });

  it("rejects typo builtin names", () => {
    expect(validateToolArgs("list_directory", {}).ok).toBe(false);
  });
});

describe("actionSchema", () => {
  it("includes all builtin tool names in enum", () => {
    const schema = buildAgentActionJsonSchema(["mcp_extra"]) as {
      properties: { tool: { anyOf: Array<{ properties?: { name?: { enum?: string[] } } }> } };
    };
    const enumNames = schema.properties.tool.anyOf.find((x) => x.properties?.name)?.properties
      ?.name?.enum;
    expect(enumNames).toEqual(
      expect.arrayContaining(BUILTIN_TOOL_SPECS.map((t) => t.name)),
    );
    expect(enumNames).toContain("mcp_extra");
  });

  it("pickConstraintMode and fallback chain", () => {
    expect(pickConstraintMode({ jsonSchemaOk: null, grammarOk: null })).toBe("json_schema");
    expect(pickConstraintMode({ jsonSchemaOk: false, grammarOk: null })).toBe("grammar");
    expect(pickConstraintMode({ jsonSchemaOk: false, grammarOk: false })).toBe("none");
    expect(nextConstraintModeAfterFailure("json_schema")).toBe("grammar");
    expect(nextConstraintModeAfterFailure("grammar")).toBe("none");
    expect(nextConstraintModeAfterFailure("none")).toBeNull();
  });
});

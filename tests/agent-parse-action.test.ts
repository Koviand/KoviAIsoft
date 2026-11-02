import { describe, expect, it } from "vitest";
import {
  parseAgentAction,
  sanitizeJsonCandidate,
  validateToolArgs,
} from "../packages/core/src/agent/parseAction";
import {
  buildAgentActionGbnf,
  buildAgentActionJsonSchema,
  buildOpenAiTools,
  looksLikeUsableAgentJson,
  nextConstraintModeAfterFailure,
  pickConstraintMode,
  toolCallsToActionJson,
} from "../packages/core/src/agent/actionSchema";
import { BUILTIN_TOOL_SPECS, CORE_TOOL_NAMES } from "../packages/core/src/agent/toolsCatalog";

describe("parseAgentAction", () => {
  it("parses fenced JSON", () => {
    const raw = '```json\n{"thought":"t","tool":null,"final":"hi"}\n```';
    expect(parseAgentAction(raw)?.final).toBe("hi");
  });

  it("keeps inner markdown fences inside final content", () => {
    const raw =
      '{"thought":"x","tool":null,"final":"run:\\n```bash\\necho hi\\n```\\ndone"}';
    expect(parseAgentAction(raw)?.final).toContain("```bash");
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

  it("checks MCP required keys from inputSchema", () => {
    const bad = validateToolArgs(
      "mcp_search",
      {},
      ["mcp_search"],
      { mcp_search: { type: "object", required: ["query"], properties: { query: { type: "string" } } } },
    );
    expect(bad.ok).toBe(false);
    const good = validateToolArgs(
      "mcp_search",
      { query: "hello" },
      ["mcp_search"],
      { mcp_search: { type: "object", required: ["query"], properties: { query: { type: "string" } } } },
    );
    expect(good.ok).toBe(true);
  });

  it("canonicalizes common typo builtin names", () => {
    expect(validateToolArgs("list_directory", { path: "." }).ok).toBe(true);
    expect(validateToolArgs("totally_unknown_tool", {}).ok).toBe(false);
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

  it("compact OpenAI tools = CORE + MCP schema", () => {
    const tools = buildOpenAiTools({
      compact: true,
      extraTools: [
        {
          name: "mcp_search",
          description: "Search",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      ],
    });
    const names = tools.map((t) => t.function.name);
    expect(names.every((n) => CORE_TOOL_NAMES.has(n) || n === "mcp_search")).toBe(true);
    expect(names).not.toContain("delete_path");
    expect(names).not.toContain("browser_navigate");
    const mcp = tools.find((t) => t.function.name === "mcp_search");
    expect(mcp?.function.parameters.properties).toMatchObject({
      query: { type: "string" },
    });
    expect(mcp?.function.parameters.required).toEqual(["query"]);
  });

  it("toolCallsToActionJson collapses non-batchable multi-calls to first tool", () => {
    const mapped = JSON.parse(
      toolCallsToActionJson([
        { function: { name: "write_file", arguments: '{"path":"a.py","content":"x"}' } },
        { function: { name: "write_file", arguments: '{"path":"b.py","content":"y"}' } },
      ]),
    );
    expect(mapped.tool?.name).toBe("write_file");
    expect(mapped.tools).toBeUndefined();
  });

  it("looksLikeUsableAgentJson and GBNF mention envelope keys", () => {
    expect(looksLikeUsableAgentJson('{"thought":"t","final":"done"}')).toBe(true);
    expect(looksLikeUsableAgentJson("Sorry I cannot help")).toBe(false);
    const gbnf = buildAgentActionGbnf();
    expect(gbnf).toMatch(/thought-kv/);
    expect(gbnf).toMatch(/tool-kv/);
  });

  it("pickConstraintMode and fallback chain", () => {
    expect(pickConstraintMode({ toolsOk: null, jsonSchemaOk: null, grammarOk: null })).toBe(
      "tools",
    );
    expect(
      pickConstraintMode(
        { toolsOk: null, jsonSchemaOk: null, grammarOk: null },
        "json_schema",
      ),
    ).toBe("json_schema");
    expect(pickConstraintMode({ toolsOk: false, jsonSchemaOk: null, grammarOk: null })).toBe(
      "json_schema",
    );
    expect(pickConstraintMode({ toolsOk: false, jsonSchemaOk: false, grammarOk: null })).toBe(
      "grammar",
    );
    expect(pickConstraintMode({ toolsOk: false, jsonSchemaOk: false, grammarOk: false })).toBe(
      "none",
    );
    expect(nextConstraintModeAfterFailure("tools")).toBe("json_schema");
    expect(nextConstraintModeAfterFailure("json_schema")).toBe("grammar");
    expect(nextConstraintModeAfterFailure("grammar")).toBe("none");
    expect(nextConstraintModeAfterFailure("none")).toBeNull();
  });
});

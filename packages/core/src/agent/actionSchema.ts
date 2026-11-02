import { BUILTIN_TOOL_SPECS } from "./toolsCatalog.js";

export type ConstraintMode = "tools" | "json_schema" | "grammar" | "none";

/** OpenAI Chat Completions `tools` array from built-in (+ extra) specs. */
export function buildOpenAiTools(
  extraToolNames: string[] = [],
): Array<{
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  const extras = extraToolNames
    .filter(Boolean)
    .filter((n) => !BUILTIN_TOOL_SPECS.some((t) => t.name === n))
    .map((name) => ({
      type: "function" as const,
      function: {
        name,
        description: `MCP/extra tool ${name}`,
        parameters: { type: "object", properties: {}, additionalProperties: true },
      },
    }));
  return [
    ...BUILTIN_TOOL_SPECS.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters as Record<string, unknown>,
      },
    })),
    ...extras,
  ];
}

/** Map native tool_calls → agent JSON envelope string. */
export function toolCallsToActionJson(
  toolCalls: Array<{
    function?: { name?: string; arguments?: string };
  }>,
  thought = "native tool_calls",
): string {
  const mapped = toolCalls
    .map((tc) => {
      const name = tc.function?.name?.trim();
      if (!name) return null;
      let args: Record<string, unknown> = {};
      const raw = tc.function?.arguments || "{}";
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        args = { _raw: raw };
      }
      return { name, args };
    })
    .filter(Boolean) as Array<{ name: string; args: Record<string, unknown> }>;
  if (mapped.length === 0) {
    return JSON.stringify({ thought, final: null });
  }
  if (mapped.length === 1) {
    return JSON.stringify({ thought, tool: mapped[0], final: null });
  }
  return JSON.stringify({
    thought,
    tools: mapped.slice(0, 3),
    final: null,
  });
}

/** Soft JSON Schema for agent step envelope (args intentionally loose). */
export function buildAgentActionJsonSchema(
  extraToolNames: string[] = [],
): Record<string, unknown> {
  const names = [
    ...BUILTIN_TOOL_SPECS.map((t) => t.name),
    ...extraToolNames.filter(Boolean),
  ];
  const unique = [...new Set(names)];
  return {
    type: "object",
    properties: {
      thought: { type: "string" },
      plan: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
          },
          required: ["id", "title"],
          additionalProperties: false,
        },
      },
      tool: {
        anyOf: [
          { type: "null" },
          {
            type: "object",
            properties: {
              name: { type: "string", enum: unique },
              args: { type: "object", additionalProperties: true },
            },
            required: ["name"],
            additionalProperties: false,
          },
        ],
      },
      tools: {
        anyOf: [
          { type: "null" },
          {
            type: "array",
            maxItems: 3,
            items: {
              type: "object",
              properties: {
                name: { type: "string", enum: unique },
                args: { type: "object", additionalProperties: true },
              },
              required: ["name"],
              additionalProperties: false,
            },
          },
        ],
      },
      final: { anyOf: [{ type: "string" }, { type: "null" }] },
    },
    required: ["thought"],
    // Prefer tool XOR tools XOR final; keep soft so local models don't hard-fail schema.
    anyOf: [
      { required: ["tool"] },
      { required: ["tools"] },
      { required: ["final"] },
      { required: ["plan"] },
    ],
    additionalProperties: true,
  };
}

/**
 * Permissive JSON-object GBNF (llama.cpp). Steers models away from prose
 * without locking tool args to a brittle schema.
 */
export function buildAgentActionGbnf(): string {
  return `root   ::= object
object ::= "{" ws (string ":" ws value ("," ws string ":" ws value)*)? "}"
array  ::= "[" ws (value ("," ws value)*)? "]"
value  ::= object | array | string | number | ("true" | "false" | "null")
string ::= "\\"" ([^"\\\\] | "\\\\" ["\\\\/bfnrt] | "\\\\u" [0-9a-fA-F]{4})* "\\""
number ::= ("-"? ([0-9] | [1-9] [0-9]*)) ("." [0-9]+)? ([eE] [-+]? [0-9]+)?
ws     ::= ([ \\t\\n])*
`;
}

export function responseFormatJsonSchema(
  extraToolNames: string[] = [],
): Record<string, unknown> {
  return {
    type: "json_schema",
    json_schema: {
      name: "kovi_agent_action",
      strict: false,
      schema: buildAgentActionJsonSchema(extraToolNames),
    },
  };
}

/** Pick next constraint mode given known server capabilities. */
export function pickConstraintMode(caps: {
  toolsOk?: boolean | null;
  jsonSchemaOk: boolean | null;
  grammarOk: boolean | null;
}): ConstraintMode {
  if (caps.toolsOk !== false) return "tools";
  if (caps.jsonSchemaOk !== false) return "json_schema";
  if (caps.grammarOk !== false) return "grammar";
  return "none";
}

export function nextConstraintModeAfterFailure(
  current: ConstraintMode,
): ConstraintMode | null {
  if (current === "tools") return "json_schema";
  if (current === "json_schema") return "grammar";
  if (current === "grammar") return "none";
  return null;
}

import { BUILTIN_TOOL_SPECS } from "./toolsCatalog.js";

export type ConstraintMode = "json_schema" | "grammar" | "none";

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
      final: { anyOf: [{ type: "string" }, { type: "null" }] },
    },
    required: ["thought"],
    // Prefer tool XOR final; keep soft so local models don't hard-fail schema.
    anyOf: [
      { required: ["tool"] },
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
  jsonSchemaOk: boolean | null;
  grammarOk: boolean | null;
}): ConstraintMode {
  if (caps.jsonSchemaOk !== false) return "json_schema";
  if (caps.grammarOk !== false) return "grammar";
  return "none";
}

export function nextConstraintModeAfterFailure(
  current: ConstraintMode,
): ConstraintMode | null {
  if (current === "json_schema") return "grammar";
  if (current === "grammar") return "none";
  return null;
}

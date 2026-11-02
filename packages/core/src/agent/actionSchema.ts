import {
  BATCHABLE_TOOL_NAMES,
  BUILTIN_TOOL_SPECS,
  CORE_TOOL_NAMES,
} from "./toolsCatalog.js";

export type ConstraintMode = "tools" | "json_schema" | "grammar" | "none";

export type ExtraToolSpec = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

function normalizeMcpParameters(inputSchema: unknown): Record<string, unknown> {
  if (inputSchema && typeof inputSchema === "object" && !Array.isArray(inputSchema)) {
    const s = inputSchema as Record<string, unknown>;
    const properties =
      s.properties && typeof s.properties === "object" && !Array.isArray(s.properties)
        ? (s.properties as Record<string, unknown>)
        : {};
    const required = Array.isArray(s.required)
      ? s.required.filter((x): x is string => typeof x === "string")
      : undefined;
    return {
      type: "object",
      properties,
      ...(required?.length ? { required } : {}),
      additionalProperties: s.additionalProperties !== false,
    };
  }
  return { type: "object", properties: {}, additionalProperties: true };
}

export type BuildToolsOpts = {
  extraTools?: ExtraToolSpec[];
  /** When true, only CORE builtins (+ no MCP unless passed — caller should omit extras). */
  compact?: boolean;
  /** Explicit allow-list of builtin names; defaults from compact. */
  allowBuiltinNames?: string[];
  /** Hide these builtin names (e.g. network tools when internet is off). */
  excludeBuiltinNames?: string[];
};

function selectBuiltinSpecs(opts?: BuildToolsOpts) {
  const exclude = new Set(opts?.excludeBuiltinNames || []);
  let specs;
  if (opts?.allowBuiltinNames?.length) {
    const allow = new Set(opts.allowBuiltinNames);
    specs = BUILTIN_TOOL_SPECS.filter((t) => allow.has(t.name));
  } else if (opts?.compact) {
    specs = BUILTIN_TOOL_SPECS.filter((t) => CORE_TOOL_NAMES.has(t.name));
  } else {
    specs = [...BUILTIN_TOOL_SPECS];
  }
  if (!exclude.size) return specs;
  return specs.filter((t) => !exclude.has(t.name));
}

/** OpenAI Chat Completions `tools` array from built-in (+ extra) specs. */
export function buildOpenAiTools(
  extraToolNamesOrOpts: string[] | BuildToolsOpts = [],
): Array<{
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  const opts: BuildToolsOpts = Array.isArray(extraToolNamesOrOpts)
    ? {
        extraTools: extraToolNamesOrOpts.filter(Boolean).map((name) => ({ name })),
      }
    : extraToolNamesOrOpts;

  const builtins = selectBuiltinSpecs(opts);
  const builtinNames = new Set<string>(builtins.map((t) => t.name));
  const extras = (opts.extraTools || [])
    .filter((t) => t?.name && !builtinNames.has(t.name))
    .map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description || `MCP/extra tool ${t.name}`,
        parameters: normalizeMcpParameters(t.inputSchema),
      },
    }));

  return [
    ...builtins.map((t) => ({
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
  opts?: { rejectBrokenArgs?: boolean },
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
        // Truncated native args — do not mask as usable {_raw} (blocks boost).
        if (opts?.rejectBrokenArgs) return null;
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
  // tools[] only when every call is BATCHABLE read-only; otherwise prefer mutating.
  const allBatchable = mapped.every((m) => BATCHABLE_TOOL_NAMES.has(m.name));
  if (!allBatchable) {
    const mutating = mapped.find((m) => !BATCHABLE_TOOL_NAMES.has(m.name));
    return JSON.stringify({ thought, tool: mutating || mapped[0], final: null });
  }
  return JSON.stringify({
    thought,
    tools: mapped.slice(0, 3),
    final: null,
  });
}

function toolNameEnum(opts?: BuildToolsOpts): string[] {
  const builtins = selectBuiltinSpecs(opts).map((t) => t.name);
  const extras = (opts?.extraTools || []).map((t) => t.name).filter(Boolean);
  return [...new Set([...builtins, ...extras])];
}

/** Soft JSON Schema for agent step envelope (args intentionally loose). */
export function buildAgentActionJsonSchema(
  extraToolNamesOrOpts: string[] | BuildToolsOpts = [],
): Record<string, unknown> {
  const opts: BuildToolsOpts = Array.isArray(extraToolNamesOrOpts)
    ? {
        extraTools: extraToolNamesOrOpts.filter(Boolean).map((name) => ({ name })),
      }
    : extraToolNamesOrOpts;
  const unique = toolNameEnum(opts);
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
 * Envelope-oriented GBNF: JSON object whose members prefer agent keys
 * (thought / tool / tools / final / plan) in any order.
 */
export function buildAgentActionGbnf(): string {
  return `root ::= "{" ws (member ("," ws member)*)? "}"
member ::= thought-kv | tool-kv | tools-kv | final-kv | plan-kv | any-kv
thought-kv ::= "\\"thought\\"" ws ":" ws string
tool-kv ::= "\\"tool\\"" ws ":" ws (null | object)
tools-kv ::= "\\"tools\\"" ws ":" ws (null | array)
final-kv ::= "\\"final\\"" ws ":" ws (null | string)
plan-kv ::= "\\"plan\\"" ws ":" ws (null | array)
any-kv ::= string ":" ws value
object ::= "{" ws (string ":" ws value ("," ws string ":" ws value)*)? "}"
array  ::= "[" ws (value ("," ws value)*)? "]"
value  ::= object | array | string | number | ("true" | "false" | null)
null   ::= "null"
string ::= "\\"" ([^"\\\\] | "\\\\" ["\\\\/bfnrt] | "\\\\u" [0-9a-fA-F]{4})* "\\""
number ::= ("-"? ([0-9] | [1-9] [0-9]*)) ("." [0-9]+)? ([eE] [-+]? [0-9]+)?
ws     ::= ([ \\t\\n])*
`;
}

/** Plan-phase schema: plan[] required, no tools. */
export function buildPlanPhaseJsonSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      thought: { type: "string" },
      plan: {
        type: "array",
        minItems: 3,
        maxItems: 7,
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            kind: {
              type: "string",
              enum: ["explore", "edit", "run", "verify", "finalize"],
            },
          },
          required: ["id", "title"],
          additionalProperties: true,
        },
      },
      tool: { type: "null" },
      final: { type: "null" },
    },
    required: ["thought", "plan"],
    additionalProperties: true,
  };
}

export function responseFormatJsonSchema(
  extraToolNamesOrOpts: string[] | BuildToolsOpts = [],
  opts?: { planOnly?: boolean },
): Record<string, unknown> {
  return {
    type: "json_schema",
    json_schema: {
      name: opts?.planOnly ? "kovi_agent_plan" : "kovi_agent_action",
      strict: false,
      schema: opts?.planOnly
        ? buildPlanPhaseJsonSchema()
        : buildAgentActionJsonSchema(extraToolNamesOrOpts),
    },
  };
}

/** True when text looks like a usable agent envelope (or Hermes tool_call). */
export function looksLikeUsableAgentJson(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return false;
  if (/<tool_call\b/i.test(t)) return true;
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) return false;
  try {
    const obj = JSON.parse(t.slice(start, end + 1)) as Record<string, unknown>;
    if (!obj || typeof obj !== "object") return false;
    if (obj.tool && typeof obj.tool === "object") return true;
    if (Array.isArray(obj.tools) && obj.tools.length > 0) return true;
    if (typeof obj.final === "string" && obj.final.trim()) return true;
    if (Array.isArray(obj.plan) && obj.plan.length > 0) return true;
    return false;
  } catch {
    return false;
  }
}

/** Pick next constraint mode given known server capabilities. */
export function pickConstraintMode(
  caps: {
    toolsOk?: boolean | null;
    jsonSchemaOk: boolean | null;
    grammarOk: boolean | null;
  },
  preferred: ConstraintMode = "tools",
): ConstraintMode {
  if (preferred === "json_schema") {
    if (caps.jsonSchemaOk !== false) return "json_schema";
    if (caps.grammarOk !== false) return "grammar";
    return "none";
  }
  if (preferred === "grammar") {
    if (caps.grammarOk !== false) return "grammar";
    return "none";
  }
  if (preferred === "none") return "none";
  // preferred tools (default)
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

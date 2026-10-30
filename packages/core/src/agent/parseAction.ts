import { BUILTIN_TOOL_SPECS } from "./toolsCatalog.js";

export interface ParsedAction {
  thought?: string;
  plan?: Array<{ id: string; title: string }>;
  tool?: { name: string; args?: Record<string, unknown> } | null;
  final?: string | null;
}

export type ParsePhase = "plan" | "execute";

export function extractBalancedObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]!;
    if (inStr) {
      if (esc) {
        esc = false;
      } else if (ch === "\\") {
        esc = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

/** Light sanitizer for common local-model JSON damage. */
export function sanitizeJsonCandidate(text: string): string {
  let s = text;
  s = s.replace(/<\s*think\s*>[\s\S]*?<\s*\/\s*think\s*>/gi, "");
  s = s.replace(/<\s*reasoning\s*>[\s\S]*?<\s*\/\s*reasoning\s*>/gi, "");
  s = s.replace(/[\u201C\u201D\u00AB\u00BB]/g, '"').replace(/[\u2018\u2019]/g, "'");
  s = s.replace(/,\s*([}\]])/g, "$1");
  return s.trim();
}

function hasPlan(obj: ParsedAction): boolean {
  return Array.isArray(obj.plan) && obj.plan.length > 0;
}

function hasTool(obj: ParsedAction): boolean {
  return Boolean(obj.tool && typeof obj.tool === "object" && obj.tool.name);
}

function hasFinal(obj: ParsedAction): boolean {
  return typeof obj.final === "string" && obj.final.trim().length > 0;
}

/** Reject empty / junk objects that are not real agent actions. */
export function isValidAgentAction(
  obj: ParsedAction | null | undefined,
  phase: ParsePhase = "execute",
): obj is ParsedAction {
  if (!obj || typeof obj !== "object") return false;
  if (phase === "plan") {
    return hasPlan(obj) || hasTool(obj) || hasFinal(obj);
  }
  return hasTool(obj) || hasFinal(obj) || hasPlan(obj);
}

function tryParse(piece: string): ParsedAction | null {
  const attempts = [piece, sanitizeJsonCandidate(piece)];
  for (const a of attempts) {
    try {
      const obj = JSON.parse(a) as ParsedAction;
      if (obj && typeof obj === "object") return obj;
    } catch {
      // next
    }
  }
  return null;
}

/** Hermes / XML-ish tool_call → JSON envelope. */
export function parseHermesToolCall(text: string): ParsedAction | null {
  if (!text || !/<tool_call\b/i.test(text)) return null;
  const block = text.match(/<tool_call\b[^>]*>([\s\S]*?)<\/\s*tool_call>/i);
  const inner = block?.[1] || text;
  const name =
    inner.match(/<tool_?name>\s*([^<]+)\s*<\/tool_?name>/i)?.[1]?.trim() ||
    inner.match(/"name"\s*:\s*"([^"]+)"/i)?.[1]?.trim() ||
    text.match(/<tool_call\b[^>]*name\s*=\s*"([^"]+)"/i)?.[1]?.trim();
  if (!name) return null;
  let args: Record<string, unknown> = {};
  const argsBlock =
    inner.match(/<arguments?\b[^>]*>([\s\S]*?)<\/\s*arguments?>/i)?.[1] ||
    inner.match(/\{[\s\S]*\}/)?.[0];
  if (argsBlock) {
    try {
      const parsed = JSON.parse(sanitizeJsonCandidate(argsBlock.trim()));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      // keep empty args
    }
  }
  return {
    thought: "hermes tool_call",
    tool: { name, args },
    final: null,
  };
}

/**
 * Parse agent JSON action from model text (fence → balanced → Hermes → sanitize).
 */
export function parseAgentAction(
  text: string,
  phase: ParsePhase = "execute",
): ParsedAction | null {
  if (!text || !text.trim()) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fence?.[1] || text;

  const candidates = [
    extractBalancedObject(raw),
    (() => {
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start < 0 || end <= start) return null;
      return raw.slice(start, end + 1);
    })(),
    sanitizeJsonCandidate(raw),
  ].filter(Boolean) as string[];

  for (const piece of candidates) {
    const parsed = tryParse(piece);
    if (parsed && isValidAgentAction(parsed, phase)) return parsed;
  }

  const hermes = parseHermesToolCall(text);
  if (hermes && isValidAgentAction(hermes, phase)) return hermes;

  return null;
}

export type ToolArgValidation =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: string };

const BUILTIN_NAMES = new Set<string>(BUILTIN_TOOL_SPECS.map((t) => t.name));

/**
 * Validate required tool args against BUILTIN_TOOL_SPECS.
 * Unknown non-MCP names are rejected (typos).
 */
export function validateToolArgs(
  toolName: string,
  args: Record<string, unknown> | undefined | null,
  extraToolNames: string[] = [],
): ToolArgValidation {
  const safe = args && typeof args === "object" && !Array.isArray(args) ? { ...args } : {};
  const isMcp = toolName.startsWith("mcp_");
  const knownExtra = extraToolNames.includes(toolName);
  if (!BUILTIN_NAMES.has(toolName) && !isMcp && !knownExtra) {
    return {
      ok: false,
      error: `Неизвестный инструмент: ${toolName}. Доступны: ${[...BUILTIN_NAMES].join(", ")}`,
    };
  }
  const spec = BUILTIN_TOOL_SPECS.find((t) => t.name === toolName);
  if (!spec) {
    return { ok: true, args: safe };
  }
  const required = (spec.parameters as { required?: string[] }).required || [];
  const missing = required.filter((key) => {
    const v = safe[key];
    if (v == null) return true;
    if (typeof v === "string" && !v.trim() && key !== "newText") return true;
    return false;
  });
  if (missing.length) {
    return {
      ok: false,
      error: `Инструмент ${toolName}: не хватает args.${missing.join(", args.")}`,
    };
  }
  return { ok: true, args: safe };
}

/** Tools that advance the plan checklist when successful. */
export const PLAN_ADVANCING_TOOLS = new Set([
  "write_file",
  "apply_patch",
  "delete_path",
  "run_terminal",
  "browser_navigate",
  "browser_click",
  "browser_type",
]);

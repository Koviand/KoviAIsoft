/**
 * Helpers for streaming agent JSON without exposing mid-token broken drafts.
 */

/** True when braces are unbalanced or the text ends mid-string / trailing comma. */
export function looksBrokenJson(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  const open = (t.match(/\{/g) || []).length;
  const close = (t.match(/\}/g) || []).length;
  return (
    open !== close ||
    /["']\s*$/.test(t) ||
    /,\s*$/.test(t) ||
    (t.includes("{") && !t.includes("}"))
  );
}

/**
 * Longest prefix that ends at brace-depth 0 outside of strings.
 * Empty string if no complete object yet.
 */
export function balancedJsonPrefix(text: string): string {
  let depth = 0;
  let inStr = false;
  let esc = false;
  let lastBalanced = 0;
  let sawObject = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      if (esc) {
        esc = false;
        continue;
      }
      if (c === "\\") {
        esc = true;
        continue;
      }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === "{") {
      depth += 1;
      sawObject = true;
    } else if (c === "}") {
      depth = Math.max(0, depth - 1);
      if (sawObject && depth === 0) lastBalanced = i + 1;
    }
  }
  return lastBalanced > 0 ? text.slice(0, lastBalanced) : "";
}

/** Prefer a complete JSON object; otherwise return original (caller decides). */
export function preferBalancedJson(text: string): string {
  const bal = balancedJsonPrefix(text);
  if (bal && !looksBrokenJson(bal)) return bal.trim();
  return text;
}

export const AGENT_JSON_SCHEMA_HINT =
  'Верни ОДИН полный JSON: {"thought":"…","tool":{"name":"…","args":{…}}|null,"final":null|string}. Без текста вокруг.';

import { v4 as uuid } from "uuid";
import type { AgentEvent, AppSettings } from "@kovi/shared";
import type { ParsedToolCall } from "../parseAction.js";
import { normalizeToolsBatch, validateToolArgs } from "../parseAction.js";
import { BATCHABLE_TOOL_NAMES } from "../toolsCatalog.js";
import { execAgentTool, type NormalizeToolArgsFn } from "../toolExec.js";
import type { BrowserTooling } from "../../tools/browser.js";
import type { McpManager } from "../../mcp/manager.js";

/** Mirror loop.coerceToolArgs aliases before validate (file/filename → path). */
function coerceBatchArgs(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...args };
  if ((next.path == null || String(next.path).trim() === "") && next.file != null) {
    next.path = next.file;
  }
  if ((next.path == null || String(next.path).trim() === "") && next.filename != null) {
    next.path = next.filename;
  }
  if ((next.path == null || String(next.path).trim() === "") && next.filepath != null) {
    next.path = next.filepath;
  }
  return next;
}

type Emit = (event: AgentEvent) => void;

/**
 * Parallel read-only tools[] (max 3). Returns combined user-facing result or rejection text.
 */
export async function runBatchTools(opts: {
  tools: ParsedToolCall[];
  settings: AppSettings;
  normalize: NormalizeToolArgsFn;
  browser: BrowserTooling;
  mcp: McpManager;
  checkpointRunId?: string;
  emit: Emit;
  isCancelled?: () => boolean;
}): Promise<{ ok: true; combined: string; count: number } | { ok: false; error: string }> {
  const batch = normalizeToolsBatch(opts.tools);
  if (!batch.ok) {
    return {
      ok: false,
      error: `tools[] отклонён: ${batch.error}. Используй tools[] только для ${[...BATCHABLE_TOOL_NAMES].join(", ")} (≤3) или один tool.`,
    };
  }
  for (const t of batch.tools) {
    const coerced = coerceBatchArgs(t.name, t.args || {});
    t.args = coerced;
    const v = validateToolArgs(t.name, coerced);
    if (!v.ok) {
      return { ok: false, error: `tools[]: ${t.name}: ${v.error}` };
    }
  }
  if (opts.isCancelled?.()) {
    return { ok: false, error: "Отменено" };
  }
  const callIds = batch.tools.map(() => uuid());
  for (let bi = 0; bi < batch.tools.length; bi++) {
    const t = batch.tools[bi]!;
    const normalized = opts.normalize(t.name, t.args || {}, opts.settings.projectRoot);
    opts.emit({
      type: "tool_call",
      name: t.name,
      args: normalized,
      callId: callIds[bi]!,
      status: "running",
    });
  }
  const results = await Promise.all(
    batch.tools.map(async (t, bi) => {
      if (opts.isCancelled?.()) {
        const message = "Отменено";
        opts.emit({
          type: "tool_result",
          callId: callIds[bi]!,
          result: message,
          isError: true,
        });
        return { name: t.name, result: message, isError: true };
      }
      try {
        const result = await execAgentTool({
          name: t.name,
          args: t.args || {},
          settings: opts.settings,
          normalize: opts.normalize,
          browser: opts.browser,
          mcp: opts.mcp,
          checkpointRunId: opts.checkpointRunId,
        });
        opts.emit({
          type: "tool_result",
          callId: callIds[bi]!,
          result,
          isError: false,
        });
        return { name: t.name, result, isError: false };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        opts.emit({
          type: "tool_result",
          callId: callIds[bi]!,
          result: message,
          isError: true,
        });
        return { name: t.name, result: message, isError: true };
      }
    }),
  );
  const combined = results
    .map((r, i) => `### ${r.name} [${r.isError ? "err" : "ok"}]\n${r.result}`)
    .join("\n\n");
  return { ok: true, combined, count: results.length };
}

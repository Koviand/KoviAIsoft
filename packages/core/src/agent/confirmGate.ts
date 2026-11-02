import type { AgentConfirmation, AppSettings } from "@kovi/shared";
import { previewPatchDiff, previewWriteDiff } from "../tools/diff.js";
import {
  internetAccessMode,
  isNetworkTool,
  networkSearchNeedsConfirm,
} from "../tools/internetAccess.js";
import {
  approvalRememberKey,
  NEVER_REMEMBER_TOOLS,
  riskForTool,
  shouldConfirmRisk,
} from "../tools/sandbox.js";

export type ConfirmRisk = "low" | "medium" | "high";

export function evaluateToolConfirmNeed(
  toolName: string,
  normalizedArgs: Record<string, unknown>,
  settings: AppSettings,
  rememberedKeys: Set<string>,
): {
  needsConfirm: boolean;
  risk: ConfirmRisk;
  rememberKey: string | null;
} {
  const risk = riskForTool(toolName, normalizedArgs, settings.projectRoot);
  const rememberKey = approvalRememberKey(
    toolName,
    normalizedArgs,
    settings.projectRoot,
  );
  // Internet off is enforced in toolExec — still treat as needing a block signal.
  if (isNetworkTool(toolName) && internetAccessMode(settings) === "off") {
    return { needsConfirm: false, risk, rememberKey };
  }
  if (risk === "low") {
    return { needsConfirm: false, risk, rememberKey };
  }
  // Never skip confirm via remember for high-risk / MCP (always ask).
  const allowRemember =
    Boolean(rememberKey) && risk !== "high" && !toolName.startsWith("mcp_");
  if (allowRemember && rememberKey && rememberedKeys.has(rememberKey)) {
    return { needsConfirm: false, risk, rememberKey };
  }
  // Mode «allow»: skip confirm for read-only web_search; browser_* keep risk rules.
  if (toolName === "web_search" && !networkSearchNeedsConfirm(settings)) {
    return { needsConfirm: false, risk, rememberKey };
  }
  // Mode «ask»: always confirm web_search even if agentRiskMode is full.
  if (toolName === "web_search" && networkSearchNeedsConfirm(settings)) {
    return { needsConfirm: true, risk, rememberKey };
  }
  const needsConfirm = shouldConfirmRisk(
    risk,
    settings.agentRiskMode || "ask",
    normalizedArgs,
    settings.projectRoot,
    toolName,
  );
  return { needsConfirm, risk, rememberKey };
}

export function buildToolConfirmation(opts: {
  id: string;
  toolName: string;
  normalizedArgs: Record<string, unknown>;
  risk: ConfirmRisk;
  settings: AppSettings;
}): AgentConfirmation {
  const { id, toolName, normalizedArgs, risk, settings } = opts;
  let diff: string | undefined;
  try {
    if (toolName === "write_file") {
      diff = previewWriteDiff(
        String(normalizedArgs.path || ""),
        String(normalizedArgs.content ?? ""),
        settings,
      );
    } else if (toolName === "apply_patch") {
      const replacements = normalizedArgs.replacements;
      if (Array.isArray(replacements) && replacements.length > 0) {
        const first = replacements[0] as { oldText?: string; newText?: string };
        diff = previewPatchDiff(
          String(normalizedArgs.path || ""),
          String(first.oldText ?? ""),
          String(first.newText ?? ""),
          settings,
        );
      } else {
        diff = previewPatchDiff(
          String(normalizedArgs.path || ""),
          String(normalizedArgs.oldText ?? ""),
          String(normalizedArgs.newText ?? ""),
          settings,
        );
      }
    }
  } catch {
    diff = undefined;
  }

  let summary: string;
  if (toolName === "web_search") {
    const q = String(normalizedArgs.query || "").trim();
    summary = q
      ? `Поиск в интернете: «${q.length > 200 ? q.slice(0, 200) + "…" : q}»`
      : "Поиск в интернете";
  } else if (toolName === "browser_navigate") {
    const url = String(normalizedArgs.url || "").trim();
    summary = url
      ? `Открыть в браузере: ${url.length > 220 ? url.slice(0, 220) + "…" : url}`
      : "Открыть URL в браузере";
  } else {
    const argPreview = JSON.stringify(normalizedArgs);
    summary = `${toolName} ${argPreview.length > 1200 ? argPreview.slice(0, 1200) + "…" : argPreview}`;
  }
  return {
    id,
    toolName,
    summary,
    args: normalizedArgs,
    risk: risk === "high" ? "high" : "medium",
    createdAt: new Date().toISOString(),
    diff,
    canRemember: !NEVER_REMEMBER_TOOLS.has(toolName) && !toolName.startsWith("mcp_"),
  };
}

import type { AgentConfirmation, AppSettings } from "@kovi/shared";
import { previewPatchDiff, previewWriteDiff } from "../tools/diff.js";
import {
  approvalRememberKey,
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
  if (risk === "low") {
    return { needsConfirm: false, risk, rememberKey };
  }
  if (rememberKey && rememberedKeys.has(rememberKey)) {
    return { needsConfirm: false, risk, rememberKey };
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

  const argPreview = JSON.stringify(normalizedArgs);
  return {
    id,
    toolName,
    summary: `${toolName} ${argPreview.length > 1200 ? argPreview.slice(0, 1200) + "…" : argPreview}`,
    args: normalizedArgs,
    risk: risk === "high" ? "high" : "medium",
    createdAt: new Date().toISOString(),
    diff,
  };
}

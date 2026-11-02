import type { AppSettings } from "@kovi/shared";
import type { BrowserTooling } from "../tools/browser.js";
import {
  applyPatchTool,
  deletePathTool,
  listDir,
  readFileTool,
  searchFiles,
  writeFileTool,
} from "../tools/files.js";
import {
  gitBranchTool,
  gitCommitTool,
  gitDiffTool,
  gitLogTool,
  gitPullTool,
  gitPushTool,
  gitStatusTool,
} from "../tools/git.js";
import {
  internetDisabledMessage,
  isInternetEnabled,
  isNetworkTool,
} from "../tools/internetAccess.js";
import { assertAllowedPath, resolveAgentPath } from "../tools/sandbox.js";
import { runTerminal } from "../tools/terminal.js";
import { webSearch } from "../tools/websearch.js";
import type { McpManager } from "../mcp/manager.js";

export type NormalizeToolArgsFn = (
  toolName: string,
  args: Record<string, unknown>,
  projectRoot: string | null,
) => Record<string, unknown>;

/** Execute a builtin / MCP tool after args normalization. */
export async function execAgentTool(opts: {
  name: string;
  args: Record<string, unknown>;
  settings: AppSettings;
  normalize: NormalizeToolArgsFn;
  browser: BrowserTooling;
  mcp: McpManager;
  checkpointRunId?: string;
}): Promise<string> {
  const { name, args, settings, normalize, browser, mcp, checkpointRunId } = opts;
  if (isNetworkTool(name) && !isInternetEnabled(settings)) {
    throw new Error(internetDisabledMessage(name));
  }
  // MCP: block network-ish tools when internet is off (name + URL-like args).
  if (name.startsWith("mcp_") && !isInternetEnabled(settings)) {
    const argBlob = JSON.stringify(args || {}).toLowerCase();
    const networkish =
      /fetch|https?|web|browse|url|download|request|api|search|scrap|crawl|remote|webhook|rest|graphql|proxy|smtp|ftp|ssh|socket/i.test(
        name,
      ) || /https?:\/\/|www\./i.test(argBlob);
    if (networkish) {
      throw new Error(internetDisabledMessage(name));
    }
  }
  const a = normalize(name, args, settings.projectRoot);
  switch (name) {
    case "list_dir":
      return listDir(String(a.path), settings);
    case "read_file":
      return readFileTool(String(a.path), settings);
    case "write_file":
      return writeFileTool(String(a.path), String(a.content ?? ""), settings, {
        checkpointRunId,
      });
    case "apply_patch":
      return applyPatchTool(
        String(a.path),
        String(a.oldText ?? ""),
        String(a.newText ?? ""),
        settings,
        a.replacements,
        { checkpointRunId },
      );
    case "delete_path":
      return deletePathTool(String(a.path), settings);
    case "search":
      return searchFiles(String(a.query ?? args.query), String(a.path), settings);
    case "git_status":
      return gitStatusTool(settings);
    case "git_diff":
      return gitDiffTool(settings, {
        staged: Boolean(a.staged ?? args.staged),
        path: a.path != null ? String(a.path) : undefined,
      });
    case "git_log":
      return gitLogTool(settings, Number(a.n ?? args.n ?? 15));
    case "git_branch":
      return gitBranchTool(settings, {
        action: a.action != null ? String(a.action) : String(args.action || "list"),
        name: a.name != null ? String(a.name) : args.name != null ? String(args.name) : undefined,
      });
    case "git_commit":
      return gitCommitTool(settings, {
        message: String(a.message ?? args.message ?? ""),
        paths: a.paths ?? args.paths,
      });
    case "git_push":
      return gitPushTool(settings, {
        remote: a.remote != null ? String(a.remote) : undefined,
        ref: a.ref != null ? String(a.ref) : undefined,
      });
    case "git_pull":
      return gitPullTool(settings, {
        remote: a.remote != null ? String(a.remote) : undefined,
        ref: a.ref != null ? String(a.ref) : undefined,
      });
    case "run_terminal":
      return runTerminal(
        String(a.command ?? a.cmd ?? ""),
        String(a.cwd ?? a.dir ?? a.workdir ?? ""),
        settings,
      );
    case "web_search": {
      const q = String(a.query ?? args.query ?? "").trim();
      if (!q) return "web_search: укажите args.query";
      return webSearch(q, settings);
    }
    case "browser_navigate":
      return browser.navigate(String(a.url ?? args.url ?? ""));
    case "browser_snapshot":
      return browser.snapshot();
    case "browser_click":
      return browser.click(String(a.selector ?? args.selector ?? ""));
    case "browser_type":
      return browser.type(
        String(a.selector ?? args.selector ?? ""),
        String(a.text ?? args.text ?? ""),
      );
    case "finish":
      return String(a.summary ?? args.summary ?? "");
    default:
      if (name.startsWith("mcp_")) {
        // Use normalized args; sandbox any path-like keys against project roots.
        const sandboxed: Record<string, unknown> = { ...a };
        for (const [k, v] of Object.entries(sandboxed)) {
          if (typeof v !== "string" || !v.trim()) continue;
          if (!/path|file|dir|cwd|folder|root/i.test(k)) continue;
          const resolved = resolveAgentPath(v, settings.projectRoot);
          assertAllowedPath(
            resolved,
            settings.fileAccessMode,
            settings.projectRoot,
            settings.modelRoots,
          );
          sandboxed[k] = resolved;
        }
        return mcp.callTool(name, sandboxed);
      }
      throw new Error(`Неизвестный инструмент: ${name}`);
  }
}

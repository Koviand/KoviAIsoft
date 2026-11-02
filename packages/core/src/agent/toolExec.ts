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
    return internetDisabledMessage(name);
  }
  // MCP tools that clearly hit the network when internetAccessMode=off.
  if (
    name.startsWith("mcp_") &&
    !isInternetEnabled(settings) &&
    /fetch|http|web|browse|url|download/i.test(name)
  ) {
    return internetDisabledMessage(name);
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
      const q = String(args.query ?? "").trim();
      if (!q) return "web_search: укажите args.query";
      return webSearch(q, settings);
    }
    case "browser_navigate":
      return browser.navigate(String(args.url));
    case "browser_snapshot":
      return browser.snapshot();
    case "browser_click":
      return browser.click(String(args.selector));
    case "browser_type":
      return browser.type(String(args.selector), String(args.text ?? ""));
    case "finish":
      return String(args.summary ?? "");
    default:
      if (name.startsWith("mcp_")) {
        return mcp.callTool(name, args);
      }
      throw new Error(`Неизвестный инструмент: ${name}`);
  }
}

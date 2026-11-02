import { describe, expect, it } from "vitest";
import { agentHasPendingWork } from "../packages/core/src/agent/finishPolicy";
import { approvalRememberKey, assertNotInternalProjectPath } from "../packages/core/src/tools/sandbox";
import {
  createWorkingMemory,
  rememberToolSuccess,
} from "../packages/core/src/agent/workingMemory";
import { toolCallsToActionJson } from "../packages/core/src/agent/actionSchema";
import { buildIncompleteEvent } from "../packages/core/src/agent/phases/budgetExhaust";

describe("Pass-2 regressions", () => {
  it("blocks writes into .git", () => {
    expect(() =>
      assertNotInternalProjectPath("C:\\proj\\.git\\config"),
    ).toThrow(/\.git/);
    expect(() =>
      assertNotInternalProjectPath("C:\\proj\\src\\main.py"),
    ).not.toThrow();
  });

  it("MCP tools have null approvalRememberKey", () => {
    expect(approvalRememberKey("mcp_demo", { x: 1 })).toBeNull();
    expect(approvalRememberKey("run_terminal", { command: "dir" })).toBeNull();
  });

  it("finalize-only pending is not blocking work", () => {
    expect(
      agentHasPendingWork({
        steps: [
          { id: "1", title: "edit", status: "done", kind: "edit" },
          { id: "2", title: "Итог", status: "pending", kind: "finalize" },
        ],
        wantsFiles: false,
        filesWritten: 0,
        substantialWrite: false,
      }),
    ).toBe(false);
    expect(
      agentHasPendingWork({
        steps: [{ id: "1", title: "write", status: "pending", kind: "edit" }],
        wantsFiles: false,
        filesWritten: 0,
        substantialWrite: false,
      }),
    ).toBe(true);
  });

  it("sticky writtenPaths survive notes ring eviction", () => {
    const wm = createWorkingMemory("goal");
    rememberToolSuccess(
      wm,
      "write_file",
      { path: "C:\\p\\a.py", content: "x".repeat(500) },
      "ok",
    );
    for (let i = 0; i < 20; i++) {
      rememberToolSuccess(wm, "run_terminal", { command: `echo ${i}` }, "ok");
    }
    expect(wm.notes.every((n) => !/^wrote /.test(n))).toBe(true);
    expect(wm.writtenPaths).toContain("C:\\p\\a.py");
    expect(wm.hadSubstantialWrite).toBe(true);
  });

  it("toolCallsToActionJson rejects broken args when asked", () => {
    const ok = toolCallsToActionJson(
      [{ function: { name: "list_dir", arguments: "{not-json" } }],
      "t",
      { rejectBrokenArgs: true },
    );
    expect(JSON.parse(ok).tool).toBeUndefined();
    expect(JSON.parse(ok).final).toBeNull();
  });

  it("looksLikeUsableAgentJson rejects {_raw} truncated tool args", async () => {
    const { looksLikeUsableAgentJson } = await import(
      "../packages/core/src/agent/actionSchema"
    );
    expect(
      looksLikeUsableAgentJson(
        JSON.stringify({
          thought: "x",
          tool: { name: "write_file", args: { _raw: '{"path":' } },
          final: null,
        }),
      ),
    ).toBe(false);
    expect(
      looksLikeUsableAgentJson(
        JSON.stringify({
          thought: "x",
          tool: { name: "list_dir", args: { path: "." } },
          final: null,
        }),
      ),
    ).toBe(true);
  });

  it("IPv4-mapped loopback is private", async () => {
    // Import via assertSafeNavigateUrl side — isPrivateIp not exported; re-test via URL.
    const { assertSafeNavigateUrl } = await import("../packages/core/src/tools/browser");
    await expect(assertSafeNavigateUrl("http://127.0.0.1/")).rejects.toThrow(/приватн|локальн/i);
    await expect(assertSafeNavigateUrl("http://[::ffff:127.0.0.1]/")).rejects.toThrow();
  });

  it("incomplete event uses stopReason time_limit copy", () => {
    const wm = createWorkingMemory("g");
    rememberToolSuccess(
      wm,
      "write_file",
      { path: "a.py", content: "x".repeat(500) },
      "ok",
    );
    const { content, event } = buildIncompleteEvent({
      workingMemory: wm,
      wantsFiles: true,
      filesWritten: 1,
      toolsUsed: 2,
      substantialWrite: true,
      stopReason: "time_limit",
    });
    expect(event.reason).toBe("time_limit");
    expect(content).toMatch(/времени/i);
  });
});

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertSafeNavigateUrl } from "../packages/core/src/tools/browser";
import { normalizeToolsBatch } from "../packages/core/src/agent/parseAction";
import { AGENT_FINISH_BLOCKED_HARD_STOP } from "../packages/core/src/agent/finishPolicy";
import { createDefaultSettings } from "../packages/shared/src";

describe("Pass-4 regressions", () => {
  it("askpass emits PAT only for github.com host prompts", async () => {
    const { gitPushTool } = await import("../packages/core/src/tools/git");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kovi-ask-"));
    try {
      const settings = createDefaultSettings(tmp);
      settings.projectRoot = tmp;
      settings.fileAccessMode = "project";
      settings.githubToken = "SECRET_PAT";
      await gitPushTool(settings, { remote: "origin" }).catch(() => undefined);
      const ask = path.join(os.tmpdir(), "kovi-git-askpass-env.js");
      expect(fs.existsSync(ask)).toBe(true);
      const body = fs.readFileSync(ask, "utf8");
      expect(body).toContain("hostOk");
      expect(body).not.toContain("!q.includes('://') && !q.includes('@')");

      const run = (prompt: string) =>
        execFileSync(process.execPath, [ask, prompt], {
          env: { ...process.env, KOVI_GIT_ASKPASS_TOKEN: "SECRET_PAT" },
          encoding: "utf8",
        });

      expect(run("Password for 'https://github.com':")).toBe("SECRET_PAT");
      expect(run("Username for 'https://github.com':")).toBe("x-access-token");
      expect(run("Enter passphrase for key '/home/u/.ssh/id_rsa':")).toBe("");
      expect(run("Password:")).toBe("");
      expect(run("Password for 'https://gitlab.com':")).toBe("");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("blocks metadata host with trailing dot", async () => {
    await expect(
      assertSafeNavigateUrl("http://metadata.google.internal./"),
    ).rejects.toThrow(/локальн|служебн|приватн/i);
  });

  it("canonicalize aliases inside tools[] batch", () => {
    const r = normalizeToolsBatch([
      { name: "read", args: { path: "a.py" } },
      { name: "list_files", args: { path: "." } },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.tools.map((t) => t.name).sort()).toEqual(["list_dir", "read_file"].sort());
    }
  });

  it("finish-blocked hard-stop constant is bounded", () => {
    expect(AGENT_FINISH_BLOCKED_HARD_STOP).toBeGreaterThanOrEqual(2);
    expect(AGENT_FINISH_BLOCKED_HARD_STOP).toBeLessThanOrEqual(5);
  });
});

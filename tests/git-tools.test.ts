import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultSettings } from "@kovi/shared";
import {
  gitBranchTool,
  gitCommitTool,
  gitDiffTool,
  gitLogTool,
  gitPullTool,
  gitPushTool,
  gitStatusTool,
} from "../packages/core/src/tools/git";

function tmpRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kovi-git-"));
  execSync("git init", { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "test@kovi.local"', { cwd: dir, stdio: "ignore" });
  execSync('git config user.name "Kovi Test"', { cwd: dir, stdio: "ignore" });
  return dir;
}

function commitFile(root: string, name: string, content: string, message: string): void {
  fs.writeFileSync(path.join(root, name), content, "utf8");
  execSync(`git add -- "${name}"`, { cwd: root, stdio: "ignore" });
  execSync(`git commit -m "${message}"`, { cwd: root, stdio: "ignore" });
}

describe("git tools", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    dirs.length = 0;
  });

  it("status / diff / commit / log on tmp repo", async () => {
    const root = tmpRepo();
    dirs.push(root);
    fs.writeFileSync(path.join(root, "a.txt"), "hello\n", "utf8");

    const settings = createDefaultSettings(root);
    settings.projectRoot = root;
    settings.fileAccessMode = "project";

    const status = await gitStatusTool(settings);
    expect(status).toMatch(/a\.txt/);

    const diff = await gitDiffTool(settings);
    expect(diff).toMatch(/exit:/);

    const commit = await gitCommitTool(settings, {
      message: "feat: add a.txt",
      paths: ["a.txt"],
    });
    expect(commit).toMatch(/exit: 0/);

    const log = await gitLogTool(settings, 5);
    expect(log).toMatch(/feat: add a\.txt/);
  });

  it("git_branch list and create", async () => {
    const root = tmpRepo();
    dirs.push(root);
    commitFile(root, "b.txt", "b\n", "init");

    const settings = createDefaultSettings(root);
    settings.projectRoot = root;
    settings.fileAccessMode = "project";

    const listed = await gitBranchTool(settings, { action: "list" });
    expect(listed).toMatch(/exit: 0/);

    const created = await gitBranchTool(settings, { action: "create", name: "feature-x" });
    expect(created).toMatch(/exit: 0/);
    expect(created).toMatch(/feature-x/);
  });

  it("git_push / git_pull via local bare remote (no network)", async () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "kovi-git-bare-"));
    const work = tmpRepo();
    const clone = fs.mkdtempSync(path.join(os.tmpdir(), "kovi-git-clone-"));
    dirs.push(bare, work, clone);

    execSync(`git init --bare "${bare}"`, { stdio: "ignore" });
    commitFile(work, "c.txt", "c1\n", "init work");
    execSync(`git remote add origin "${bare}"`, { cwd: work, stdio: "ignore" });
    execSync("git push -u origin HEAD", { cwd: work, stdio: "ignore" });

    execSync(`git clone "${bare}" "${clone}"`, { stdio: "ignore" });
    execSync('git config user.email "test@kovi.local"', { cwd: clone, stdio: "ignore" });
    execSync('git config user.name "Kovi Test"', { cwd: clone, stdio: "ignore" });

    const settingsWork = createDefaultSettings(work);
    settingsWork.projectRoot = work;
    settingsWork.fileAccessMode = "project";

    fs.writeFileSync(path.join(work, "c.txt"), "c2\n", "utf8");
    await gitCommitTool(settingsWork, { message: "feat: bump c", paths: ["c.txt"] });

    const push = await gitPushTool(settingsWork, { remote: "origin" });
    expect(push).toMatch(/exit: 0/);
    // Askpass script must not embed a PAT even if token set.
    settingsWork.githubToken = "ghp_fake_should_not_land_on_disk";
    const ask = path.join(os.tmpdir(), "kovi-git-askpass-env.js");
    await gitPushTool(settingsWork, { remote: "origin" });
    if (fs.existsSync(ask)) {
      const body = fs.readFileSync(ask, "utf8");
      expect(body).not.toContain("ghp_fake");
      expect(body).toContain("KOVI_GIT_ASKPASS_TOKEN");
    }

    const settingsClone = createDefaultSettings(clone);
    settingsClone.projectRoot = clone;
    settingsClone.fileAccessMode = "project";
    const pull = await gitPullTool(settingsClone, { remote: "origin" });
    expect(pull).toMatch(/exit: 0/);
    expect(fs.readFileSync(path.join(clone, "c.txt"), "utf8")).toContain("c2");
  });
});

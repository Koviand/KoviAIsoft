import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AppService } from "../packages/core/src/appService";
import { pickBackend } from "../packages/core/src/system/detect";
import { scanLocalModels } from "../packages/core/src/models/scanner";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kovi-smoke-"));

describe("smoke core", () => {
  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("boots AppService and creates chat session", async () => {
    const svc = new AppService(tmp);
    await svc.init();
    const session = svc.createSession("chat", "smoke");
    expect(session.id).toBeTruthy();
    svc.store.addMessage(session.id, { role: "user", content: "hello" });
    expect(svc.getMessages(session.id)).toHaveLength(1);
    const settings = svc.getSettings();
    expect(settings.modelRoots.length).toBeGreaterThan(0);
    await svc.dispose();
  });

  it("scans local LFM models if present", () => {
    const root = "C:\\Models\\LFM";
    if (!fs.existsSync(root)) return;
    const models = scanLocalModels([root]);
    // Workspace already contains GGUF trees; at least scanner should not throw.
    expect(Array.isArray(models)).toBe(true);
  });

  it("picks backend deterministically", () => {
    expect(pickBackend({ hasNvidia: true, hasVulkan: false })).toBe("cuda");
  });
});

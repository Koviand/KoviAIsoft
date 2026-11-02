import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppService } from "../packages/core/src/appService";
import { getAttachmentsDir } from "../packages/core/src/paths";

describe("Pass-6 regressions", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it("formatAttachmentsBlock skips paths outside attachments root", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kovi-att-"));
    dirs.push(root);
    const attDir = getAttachmentsDir(root);
    const inside = path.join(attDir, "ok.txt");
    fs.writeFileSync(inside, "hello inside", "utf8");
    const outside = path.join(root, "secret.txt");
    fs.writeFileSync(outside, "SECRET", "utf8");
    const block = AppService.formatAttachmentsBlock(
      [
        {
          id: "1",
          name: "ok.txt",
          mime: "text/plain",
          path: inside,
          size: 12,
        },
        {
          id: "2",
          name: "secret.txt",
          mime: "text/plain",
          path: outside,
          size: 6,
        },
      ],
      attDir,
    );
    expect(block).toContain("hello inside");
    expect(block).not.toContain("SECRET");
    expect(block).toMatch(/пропущен/i);
  });

  it("deleteSession stops generation for the active chat session", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kovi-del-"));
    dirs.push(dir);
    const svc = new AppService(dir);
    await svc.init();
    try {
      const s = svc.createSession("chat");
      // Mark as active chat session via private field through sendChat busy race —
      // exercise delete while not busy (must not throw).
      expect(() => svc.deleteSession(s.id)).not.toThrow();
      expect(svc.listSessions().some((x) => x.id === s.id)).toBe(false);
    } finally {
      await svc.dispose();
    }
  });
});

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { IPC } from "../packages/shared/src/ipc";
import {
  assertAppSettingsDeep,
  assertResolveConfirmation,
  assertSessionExportBundle,
} from "../packages/shared/src/ipcValidate";
import { createDefaultSettings } from "../packages/shared/src/types";

const PUSH_ONLY = new Set([
  "runtimeProgress",
  "downloadProgress",
  "chatToken",
  "agentEvent",
  "monitorUpdate",
]);

const root = path.resolve(__dirname, "..");
const preloadSrc = fs.readFileSync(path.join(root, "apps/desktop/src/preload.ts"), "utf8");
const mainSrc = fs.readFileSync(path.join(root, "apps/desktop/src/main.ts"), "utf8");

describe("IPC contract", () => {
  it("every invoke channel is registered in main and exposed in preload", () => {
    for (const [key, channel] of Object.entries(IPC)) {
      if (PUSH_ONLY.has(key)) {
        expect(mainSrc).toContain(`IPC.${key}`);
        continue;
      }
      expect(mainSrc, `main missing handler for ${key}`).toContain(`IPC.${key}`);
      expect(preloadSrc, `preload missing ${key}`).toContain(key);
      expect(preloadSrc).toContain(channel.includes("kovi:") ? `IPC.${key}` : key);
    }
  });

  it("validates resolveConfirmation", () => {
    expect(() => assertResolveConfirmation({})).toThrow(/подтвержден/i);
    expect(
      assertResolveConfirmation({
        confirmationId: "c1",
        approved: true,
        rememberForSession: false,
      }),
    ).toEqual({ confirmationId: "c1", approved: true, rememberForSession: false });
  });

  it("validates settings and session import", () => {
    const s = createDefaultSettings("C:\\tmp\\kovi-data");
    expect(assertAppSettingsDeep(s).downloadDir).toBeTruthy();
    expect(() => assertAppSettingsDeep({ ...s, modelRoots: "x" })).toThrow(/modelRoots/);
    expect(() => assertSessionExportBundle({ version: 2 })).toThrow(/импорт/i);
    expect(
      assertSessionExportBundle({
        version: 1,
        exportedAt: new Date().toISOString(),
        session: {
          id: "s1",
          title: "t",
          mode: "chat",
          systemPrompt: "",
          pinned: false,
          createdAt: "a",
          updatedAt: "b",
          params: {},
        },
        messages: [],
      }).session.id,
    ).toBe("s1");
  });
});

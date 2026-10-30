import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsStore } from "../packages/core/src/settings";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("settings atomic + backup", () => {
  it("backs up corrupt settings and loads defaults", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kovi-settings-"));
    temps.push(dir);
    const settingsPath = path.join(dir, "settings.json");
    fs.writeFileSync(settingsPath, "{not-json", "utf8");

    const store = new SettingsStore(dir);
    expect(store.get().themePreset).toBeTruthy();
    expect(fs.existsSync(path.join(dir, "settings.json.bak"))).toBe(true);
    expect(fs.readFileSync(settingsPath, "utf8")).toContain("themePreset");
  });

  it("round-trips save atomically", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kovi-settings-"));
    temps.push(dir);
    const store = new SettingsStore(dir);
    const next = store.get();
    next.projectRoot = path.join(dir, "proj");
    await store.save(next);
    const again = new SettingsStore(dir);
    expect(again.get().projectRoot).toBe(next.projectRoot);
  });

  it("accepts named theme presets", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kovi-settings-"));
    temps.push(dir);
    const store = new SettingsStore(dir);
    const next = store.get();
    next.themePreset = "ocean";
    await store.save(next);
    expect(new SettingsStore(dir).get().themePreset).toBe("ocean");
  });

  it("persists custom downloadDir and rejects empty", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kovi-settings-"));
    temps.push(dir);
    const store = new SettingsStore(dir);
    const custom = path.join(dir, "gguf-downloads");
    const next = store.get();
    next.downloadDir = custom;
    await store.save(next);
    expect(new SettingsStore(dir).get().downloadDir).toBe(custom);

    const blank = store.get();
    blank.downloadDir = "   ";
    await store.save(blank);
    // mergePartial falls back when empty/whitespace after reload from file...
    // save writes as-is; load normalizes empty on next SettingsStore ctor.
    fs.writeFileSync(
      path.join(dir, "settings.json"),
      JSON.stringify({ ...blank, downloadDir: "   " }, null, 2),
      "utf8",
    );
    const reloaded = new SettingsStore(dir);
    expect(reloaded.get().downloadDir.trim().length).toBeGreaterThan(0);
    expect(reloaded.get().downloadDir).not.toBe("   ");
  });
});

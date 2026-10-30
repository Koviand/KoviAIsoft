import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../packages/core/src/db/store";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe("store load safety", () => {
  it("backs up corrupt JSON and starts empty", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kovi-store-"));
    dirs.push(dir);
    const file = path.join(dir, "store.json");
    fs.writeFileSync(file, "{not-json", "utf8");
    const store = new Store(dir);
    expect(store.listSessions()).toEqual([]);
    expect(fs.existsSync(`${file}.bak`)).toBe(true);
    store.createSession("chat", "ok");
    store.close();
    const raw = fs.readFileSync(file, "utf8");
    expect(JSON.parse(raw).sessions.length).toBe(1);
  });

  it("does not wipe unreadable existing file (I/O blocked)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kovi-store-io-"));
    dirs.push(dir);
    const file = path.join(dir, "store.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ sessions: [{ id: "keep-me" }], messages: {} }),
      "utf8",
    );
    // Simulate I/O failure by replacing file with a directory of the same name.
    fs.unlinkSync(file);
    fs.mkdirSync(file);
    const store = new Store(dir);
    expect(store.listSessions()).toEqual([]);
    // Persist must be blocked — directory "store.json" still exists (not overwritten as file).
    store.createSession("chat", "should-not-persist");
    expect(fs.statSync(file).isDirectory()).toBe(true);
  });
});

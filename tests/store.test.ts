import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Store } from "../packages/core/src/db/store";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kovi-store-"));

describe("store", () => {
  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("persists sessions and messages", () => {
    const store = new Store(tmp);
    const session = store.createSession("agent", "t1");
    expect(session.toolsEnabled).toBe(true);
    store.addMessage(session.id, { role: "user", content: "hi" });
    store.close();

    const store2 = new Store(tmp);
    expect(store2.listSessions()[0]?.title).toBe("t1");
    expect(store2.listSessions()[0]?.toolsEnabled).toBe(true);
    expect(store2.getMessages(session.id)[0]?.content).toBe("hi");
    store2.deleteSession(session.id);
    expect(store2.listSessions().find((s) => s.id === session.id)).toBeUndefined();
    store2.close();
  });

  it("toggles toolsEnabled and flushes debounced writes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kovi-store-tools-"));
    const store = new Store(dir);
    const session = store.createSession("chat", "plain");
    expect(session.toolsEnabled).toBe(false);
    const updated = store.setToolsEnabled(session.id, true);
    expect(updated?.mode).toBe("agent");
    store.close();
    const again = new Store(dir);
    expect(again.listSessions()[0]?.toolsEnabled).toBe(true);
    again.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

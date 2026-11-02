import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../packages/core/src/db/store";

describe("sqlite store migrate", () => {
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

  it("migrates store.json → store.sqlite and roundtrips", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kovi-sqlite-"));
    dirs.push(dir);

    const seed = {
      sessions: [
        {
          id: "s1",
          title: "Seed",
          mode: "chat",
          toolsEnabled: false,
          systemPrompt: "x",
          pinned: true,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          params: {},
        },
      ],
      messages: {
        s1: [
          {
            id: "m1",
            role: "user",
            content: "hello sqlite",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    };
    fs.writeFileSync(path.join(dir, "store.json"), JSON.stringify(seed), "utf8");

    const store = new Store(dir);
    await store.ready();
    expect(store.listSessions()[0]?.title).toBe("Seed");
    expect(store.listSessions()[0]?.pinned).toBe(true);
    expect(store.getMessages("s1")[0]?.content).toBe("hello sqlite");

    store.addMessage("s1", { role: "assistant", content: "pong" });
    await store.flush();
    store.close();

    expect(fs.existsSync(path.join(dir, "store.sqlite"))).toBe(true);

    const again = new Store(dir);
    await again.ready();
    expect(again.getMessages("s1").map((m) => m.content)).toEqual([
      "hello sqlite",
      "pong",
    ]);
    again.close();
  });
});

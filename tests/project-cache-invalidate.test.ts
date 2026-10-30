import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectContextCache } from "../packages/core/src/context/projectCache";
import { invalidateIndexPaths } from "../packages/core/src/context/semanticIndex";

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe("project cache after file mutation", () => {
  it("invalidateRoot + invalidateIndexPaths makes retrieve see new content", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kovi-cache-"));
    tmpRoots.push(root);
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    const file = path.join(root, "src", "tetris.py");
    fs.writeFileSync(
      file,
      "import pygame\n\ndef main():\n    print('BEFORE_MUTATION')\n",
      "utf8",
    );

    const cache = new ProjectContextCache(60_000);
    const query = "tetris pygame BEFORE_MUTATION";
    const first = await cache.getRetrieved(root, query, {
      maxFiles: 4,
      maxBytesPerFile: 2000,
      maxTotalBytes: 8000,
      forceSemantic: false,
    });
    const firstBlob = first.map((s) => s.excerpt).join("\n");
    expect(firstBlob).toContain("BEFORE_MUTATION");

    fs.writeFileSync(
      file,
      "import pygame\n\ndef main():\n    print('AFTER_MUTATION_VISIBLE')\n",
      "utf8",
    );

    // Stale cache would still return BEFORE without invalidate.
    const stale = await cache.getRetrieved(root, query, {
      maxFiles: 4,
      maxBytesPerFile: 2000,
      maxTotalBytes: 8000,
      forceSemantic: false,
    });
    expect(stale.map((s) => s.excerpt).join("\n")).toContain("BEFORE_MUTATION");

    cache.invalidateRoot(root);
    await invalidateIndexPaths(root, ["src/tetris.py"]);

    const fresh = await cache.getRetrieved(root, "tetris pygame AFTER_MUTATION_VISIBLE", {
      maxFiles: 4,
      maxBytesPerFile: 2000,
      maxTotalBytes: 8000,
      forceSemantic: false,
    });
    const freshBlob = fresh.map((s) => s.excerpt).join("\n");
    expect(freshBlob).toContain("AFTER_MUTATION_VISIBLE");
    expect(freshBlob).not.toContain("BEFORE_MUTATION");
  });
});

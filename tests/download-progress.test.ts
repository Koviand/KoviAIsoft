import { describe, expect, it } from "vitest";
import { Transform } from "node:stream";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

describe("download stream progress tap", () => {
  it("does not lose bytes when progress Transform is used", async () => {
    const tmp = path.join(os.tmpdir(), `kovi-dl-${Date.now()}.bin`);
    const payload = crypto.randomBytes(64 * 1024 + 123);
    let seen = 0;
    const src = Readable.from([payload.subarray(0, 1000), payload.subarray(1000)]);
    const tap = new Transform({
      transform(chunk, _enc, cb) {
        seen += chunk.length;
        cb(null, chunk);
      },
    });
    const out = fs.createWriteStream(tmp);
    await pipeline(src, tap, out);
    const got = await fsp.readFile(tmp);
    expect(seen).toBe(payload.length);
    expect(got.equals(payload)).toBe(true);
    await fsp.unlink(tmp);
  });
});

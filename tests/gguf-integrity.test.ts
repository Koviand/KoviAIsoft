import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { verifyGgufSync } from "../packages/core/src/models/integrity.js";

describe("gguf integrity", () => {
  it("accepts GGUF magic header", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kovi-gguf-"));
    const file = path.join(dir, "ok.gguf");
    const buf = Buffer.alloc(32, 0);
    buf.write("GGUF", 0, "ascii");
    fs.writeFileSync(file, buf);
    expect(verifyGgufSync(file).ok).toBe(true);
  });

  it("rejects non-gguf", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kovi-gguf-"));
    const file = path.join(dir, "bad.gguf");
    fs.writeFileSync(file, Buffer.alloc(32, 0x41));
    const r = verifyGgufSync(file);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/сигнатур|маленьк/i);
  });
});

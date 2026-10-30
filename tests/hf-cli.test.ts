import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getHfCliStatus, resolveHfCli } from "../packages/core/src/models/hfCli";
import {
  isBundledHfCliReady,
  resolveBundledHfCli,
} from "../packages/core/src/models/hfBundle";

describe("HF CLI status", () => {
  it("returns a status object with hint and bundled flag", () => {
    const s = getHfCliStatus();
    expect(typeof s.available).toBe("boolean");
    expect(typeof s.bundled).toBe("boolean");
    expect(typeof s.hint).toBe("string");
    expect(s.hint.length).toBeGreaterThan(10);
    if (s.available) {
      expect(s.binary).toBeTruthy();
      expect(s.mode).toBeTruthy();
    } else {
      expect(s.binary).toBeNull();
      expect(s.mode).toBeNull();
    }
  });

  it("resolveBundledHfCli is null without ready marker", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kovi-hf-"));
    expect(isBundledHfCliReady(dir)).toBe(false);
    expect(resolveBundledHfCli(dir)).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("resolveHfCli prefers mocked bundled layout", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kovi-hf-"));
    const pythonDir = path.join(dir, "python");
    fs.mkdirSync(pythonDir, { recursive: true });
    const py = path.join(pythonDir, "python.exe");
    fs.writeFileSync(py, "");
    fs.writeFileSync(
      path.join(dir, ".hf-ready"),
      JSON.stringify({ command: py, prefixArgs: ["-m", "huggingface_hub.cli.hf"] }),
    );
    const bundled = resolveBundledHfCli(dir);
    expect(bundled?.command).toBe(py);
    expect(bundled?.prefixArgs.join(" ")).toContain("huggingface_hub");
    expect(() => resolveHfCli()).not.toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

afterEach(() => {
  // no shared state
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deleteLocalModelFiles,
  isUnderModelRoots,
} from "../packages/core/src/models/deleteLocal";
import type { LocalModel } from "../packages/shared/src/types";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeModel(filePath: string, mmprojPath?: string): LocalModel {
  return {
    id: "test",
    name: path.basename(filePath, ".gguf"),
    path: filePath,
    sizeBytes: 10,
    directory: path.dirname(filePath),
    recommendedNgl: 0,
    recommendedContext: 4096,
    mmprojPath,
  };
}

describe("deleteLocalModelFiles", () => {
  it("rejects paths outside modelRoots", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kovi-models-"));
    temps.push(root);
    const outside = path.join(os.tmpdir(), "outside-model.gguf");
    const model = makeModel(outside);
    expect(() => deleteLocalModelFiles(model, [root])).toThrow(/вне разрешённых/);
  });

  it("deletes gguf and orphan mmproj", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kovi-models-"));
    temps.push(root);
    const gguf = path.join(root, "foo-Q4_K_M.gguf");
    const mmproj = path.join(root, "mmproj-foo.gguf");
    fs.writeFileSync(gguf, "gguf");
    fs.writeFileSync(mmproj, "mm");
    const result = deleteLocalModelFiles(makeModel(gguf, mmproj), [root]);
    expect(result.deleted).toContain(gguf);
    expect(result.deleted).toContain(mmproj);
    expect(fs.existsSync(gguf)).toBe(false);
    expect(fs.existsSync(mmproj)).toBe(false);
  });

  it("keeps mmproj when another gguf shares the folder", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kovi-models-"));
    temps.push(root);
    const a = path.join(root, "a.gguf");
    const b = path.join(root, "b.gguf");
    const mmproj = path.join(root, "mmproj.gguf");
    fs.writeFileSync(a, "a");
    fs.writeFileSync(b, "b");
    fs.writeFileSync(mmproj, "m");
    deleteLocalModelFiles(makeModel(a, mmproj), [root]);
    expect(fs.existsSync(a)).toBe(false);
    expect(fs.existsSync(b)).toBe(true);
    expect(fs.existsSync(mmproj)).toBe(true);
  });

  it("isUnderModelRoots handles nested paths", () => {
    const root = "C:\\Models\\LFM";
    expect(isUnderModelRoots("C:\\Models\\LFM\\x\\y.gguf", [root])).toBe(true);
    expect(isUnderModelRoots("C:\\Other\\y.gguf", [root])).toBe(false);
  });
});

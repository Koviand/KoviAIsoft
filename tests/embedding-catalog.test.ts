import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  applyEmbeddingPrefix,
  pickLfmGgufFilename,
  listEmbeddingModels,
  getEmbeddingSpec,
} from "../packages/core/src/context/embeddingCatalog";
import {
  embedTexts,
  hashEmbed,
  setEmbedderOverride,
  setEmbeddingRuntimeConfig,
  resetEmbedder,
  getEmbeddingDim,
} from "../packages/core/src/context/embedder";
import { SettingsStore } from "../packages/core/src/settings";
import { setAppDataDir } from "../packages/core/src/paths";
import {
  ensureProjectIndex,
  indexDirForProject,
} from "../packages/core/src/context/semanticIndex";

describe("pickLfmGgufFilename", () => {
  it("prefers Q8_0 then Q4 then first gguf", () => {
    expect(
      pickLfmGgufFilename([
        "LFM2.5-Embedding-350M-Q4_K_M.gguf",
        "LFM2.5-Embedding-350M-Q8_0.gguf",
        "readme.md",
      ]),
    ).toBe("LFM2.5-Embedding-350M-Q8_0.gguf");

    expect(
      pickLfmGgufFilename([
        "model-Q4_0.gguf",
        "model-Q5_K_M.gguf",
      ]),
    ).toBe("model-Q4_0.gguf");

    expect(pickLfmGgufFilename(["a.gguf", "b.gguf"])).toBe("a.gguf");
  });

  it("throws when no gguf", () => {
    expect(() => pickLfmGgufFilename(["readme.md"])).toThrow(/GGUF/i);
  });
});

describe("applyEmbeddingPrefix", () => {
  it("adds query/document prefixes for LFM", () => {
    expect(applyEmbeddingPrefix("hello", "query", true)).toBe("query: hello");
    expect(applyEmbeddingPrefix("hello", "document", true)).toBe("document: hello");
  });

  it("skips when model does not use prefixes", () => {
    expect(applyEmbeddingPrefix("hello", "query", false)).toBe("hello");
  });

  it("replaces wrong role prefix", () => {
    expect(applyEmbeddingPrefix("query: hello", "document", true)).toBe("document: hello");
  });
});

describe("settings embeddingModelId migrate", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kovi-emb-set-"));

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("defaults missing field to minilm", () => {
    const settingsPath = path.join(tmp, "settings.json");
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        language: "ru",
        themePreset: "light",
        modelRoots: [],
        downloadDir: path.join(tmp, "models"),
      }),
      "utf8",
    );
    const store = new SettingsStore(tmp);
    expect(store.get().embeddingModelId).toBe("minilm");
  });
});

describe("embedTexts LFM prefixes (hash path)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kovi-emb-rt-"));

  afterAll(() => {
    setEmbedderOverride(null);
    resetEmbedder();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("lfm25 prefixes before hash embed when no override", async () => {
    setAppDataDir(tmp);
    setEmbedderOverride(null);
    setEmbeddingRuntimeConfig({
      modelId: "lfm25",
      appData: tmp,
      getServerPath: () => null,
    });
    expect(getEmbeddingDim()).toBe(1024);
    expect(getEmbeddingSpec("lfm25").usesPrefixes).toBe(true);

    const [withRole] = await embedTexts(["alpha"], { role: "query" });
    const expected = hashEmbed("query: alpha", 1024);
    expect(withRole!.length).toBe(1024);
    expect([...withRole!].slice(0, 8)).toEqual([...expected].slice(0, 8));
  });
});

describe("semanticIndex rebuild on modelId/dim change", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kovi-emb-idx-"));
  const project = path.join(tmp, "proj");
  const data = path.join(tmp, "data");

  afterAll(() => {
    setEmbedderOverride(null);
    resetEmbedder();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("rebuilds when active embedding meta changes", async () => {
    setAppDataDir(data);
    setEmbeddingRuntimeConfig({
      modelId: "minilm",
      appData: data,
      getServerPath: () => null,
    });
    setEmbedderOverride(async (texts) => texts.map((t) => hashEmbed(t, 384)));

    fs.mkdirSync(path.join(project, "src"), { recursive: true });
    fs.writeFileSync(path.join(project, "src", "a.ts"), "export const x = 1;\n", "utf8");

    const st1 = await ensureProjectIndex(project);
    expect(st1.error).toBeNull();
    expect(st1.modelId).toContain("minilm");

    const dir = indexDirForProject(project);
    const meta1 = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")) as {
      modelId: string;
      dim: number;
      chunkCount: number;
    };
    expect(meta1.dim).toBe(384);

    setEmbeddingRuntimeConfig({
      modelId: "lfm25",
      appData: data,
      getServerPath: () => null,
    });
    setEmbedderOverride(async (texts) => texts.map((t) => hashEmbed(t, 1024)));

    const st2 = await ensureProjectIndex(project);
    expect(st2.error).toBeNull();
    expect(st2.modelId).toContain("lfm25");
    const meta2 = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")) as {
      modelId: string;
      dim: number;
    };
    expect(meta2.dim).toBe(1024);
    expect(meta2.modelId).not.toBe(meta1.modelId);
  });
});

describe("listEmbeddingModels status", () => {
  it("reports minilm/lfm25 entries", () => {
    const models = listEmbeddingModels({ appData: os.tmpdir(), llamaServerPath: null });
    expect(models.map((m) => m.id)).toEqual(["minilm", "lfm25"]);
    expect(models.find((m) => m.id === "lfm25")!.dim).toBe(1024);
  });
});

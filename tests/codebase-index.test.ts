import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { chunkSourceText } from "../packages/core/src/context/chunker";
import {
  hashEmbed,
  setEmbedderOverride,
  setEmbeddingRuntimeConfig,
} from "../packages/core/src/context/embedder";
import {
  ensureProjectIndex,
  semanticSearch,
} from "../packages/core/src/context/semanticIndex";
import {
  hasCodebaseMention,
  retrieveProjectContext,
  stripCodebaseMention,
} from "../packages/core/src/context/retrieve";
import { setAppDataDir } from "../packages/core/src/paths";

describe("chunker", () => {
  it("splits long files into overlapping chunks", () => {
    const lines = Array.from({ length: 80 }, (_, i) => `line ${i} content here`);
    const chunks = chunkSourceText("src/demo.ts", lines.join("\n"), {
      targetChars: 200,
      overlapChars: 40,
    });
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0]!.startLine).toBe(1);
    expect(chunks.every((c) => c.relPath === "src/demo.ts")).toBe(true);
  });
});

describe("@codebase mention helpers", () => {
  it("detects and strips @codebase", () => {
    expect(hasCodebaseMention("find @codebase auth")).toBe(true);
    expect(stripCodebaseMention("find @codebase auth")).toBe("find auth");
  });
});

describe("semantic index (hash embedder)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kovi-idx-"));
  const project = path.join(tmp, "proj");
  const data = path.join(tmp, "data");

  beforeAll(() => {
    setAppDataDir(data);
    setEmbeddingRuntimeConfig({
      modelId: "minilm",
      appData: data,
      getServerPath: () => null,
    });
    setEmbedderOverride(async (texts) => texts.map((t) => hashEmbed(t, 384)));
    fs.mkdirSync(path.join(project, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(project, "src", "auth.ts"),
      [
        "export function login(user: string, password: string) {",
        "  return validateUser(user, password);",
        "}",
        "function validateUser(u: string, p: string) { return u === p; }",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(project, "src", "ui.ts"),
      "export function renderButton() { return '<button>OK</button>'; }\n",
      "utf8",
    );
  });

  afterEach(() => {
    // keep override for suite
  });

  afterAll(() => {
    setEmbedderOverride(null);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("indexes and finds auth-related chunks", async () => {
    const st = await ensureProjectIndex(project);
    expect(st.error).toBeNull();
    expect(st.chunkCount).toBeGreaterThan(0);
    const hits = await semanticSearch(project, "user login password validate", 4);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => /auth/i.test(h.relPath))).toBe(true);
  });

  it("hybrid retrieve with @codebase merges semantic", async () => {
    const snippets = await retrieveProjectContext(project, "@codebase login password", {
      maxFiles: 4,
      forceSemantic: true,
    });
    expect(snippets.length).toBeGreaterThan(0);
    expect(snippets.some((s) => /semantic|mention|name|rg|auth/i.test(s.reason + s.path))).toBe(
      true,
    );
  });
});

import { describe, expect, it } from "vitest";
import {
  agentTuningForFamily,
  detectModelFamily,
  looksLikeSmallOrUnknownModel,
  modelIdentityForTuning,
  preferredConstraintMode,
} from "../packages/core/src/models/modelFamily";

describe("detectModelFamily", () => {
  it("detects common GGUF names", () => {
    expect(detectModelFamily("Qwen2.5-7B-Instruct-Q4_K_M.gguf")).toBe("qwen");
    expect(detectModelFamily("DeepSeek-R1-Distill-Qwen-8B.gguf")).toBe("deepseek");
    expect(detectModelFamily("LFM2-2.6B-Q8_0.gguf")).toBe("lfm");
    expect(detectModelFamily("Meta-Llama-3.1-8B-Instruct.gguf")).toBe("llama");
    expect(detectModelFamily("mistral-7b-instruct.gguf")).toBe("mistral");
    expect(detectModelFamily("gemma-2-9b.gguf")).toBe("gemma");
    expect(detectModelFamily("mystery-model.gguf")).toBe("other");
  });
});

describe("modelIdentityForTuning", () => {
  it("prefers name over path over hash id", () => {
    const hash = "a".repeat(16);
    expect(
      modelIdentityForTuning({
        loadedModelId: hash,
        loadedModelName: "Qwen2.5-Coder-7B-Instruct.gguf",
        loadedModelPath: "C:/models/qwen.gguf",
      }),
    ).toBe("Qwen2.5-Coder-7B-Instruct.gguf");
    expect(
      modelIdentityForTuning({
        loadedModelId: hash,
        loadedModelName: null,
        loadedModelPath: "C:/models/LFM2-2.6B.gguf",
      }),
    ).toMatch(/LFM2-2\.6B/);
    expect(
      modelIdentityForTuning({
        loadedModelId: hash,
        loadedModelName: null,
        loadedModelPath: null,
      }),
    ).toBe(hash);
  });

  it("detects family from name even when id is opaque hash", () => {
    const identity = modelIdentityForTuning({
      loadedModelId: "deadbeefdeadbeef",
      loadedModelName: "qwen2.5-coder-7b-instruct.gguf",
    });
    expect(detectModelFamily(identity)).toBe("qwen");
    expect(looksLikeSmallOrUnknownModel(identity)).toBe(false);
    expect(preferredConstraintMode("qwen", identity)).toBe("tools");
  });
});

describe("looksLikeSmallOrUnknownModel", () => {
  it("covers LFM 1.2B / 2.6B and classic tiny sizes", () => {
    expect(looksLikeSmallOrUnknownModel("lfm2-1.2b-instruct.gguf")).toBe(true);
    expect(looksLikeSmallOrUnknownModel("LFM2-2.6B-Q8_0.gguf")).toBe(true);
    expect(looksLikeSmallOrUnknownModel("qwen2.5-coder-1.5b-ins.gguf")).toBe(true);
    expect(looksLikeSmallOrUnknownModel("Qwen2.5-Coder-7B-Instruct.gguf")).toBe(false);
  });
});

describe("preferredConstraintMode", () => {
  it("starts json_schema for deepseek, lfm, tiny, other", () => {
    expect(preferredConstraintMode("deepseek", "DeepSeek-R1-Distill-Qwen-8B.gguf")).toBe(
      "json_schema",
    );
    expect(preferredConstraintMode("lfm", "LFM2-2.6B.gguf")).toBe("json_schema");
    expect(preferredConstraintMode("qwen", "qwen2.5-coder-1.5b.gguf")).toBe("json_schema");
    expect(preferredConstraintMode("other", "phi-4.gguf")).toBe("json_schema");
  });

  it("starts tools for large qwen/llama/mistral/gemma", () => {
    expect(preferredConstraintMode("qwen", "Qwen2.5-Coder-7B-Instruct.gguf")).toBe("tools");
    expect(preferredConstraintMode("llama", "Meta-Llama-3.1-8B-Instruct.gguf")).toBe("tools");
    expect(preferredConstraintMode("mistral", "mistral-7b-instruct.gguf")).toBe("tools");
    expect(preferredConstraintMode("gemma", "gemma-2-9b.gguf")).toBe("tools");
  });
});

describe("agentTuningForFamily", () => {
  it("caps temperature for tool use", () => {
    expect(agentTuningForFamily("deepseek").temperatureCap).toBeLessThanOrEqual(0.35);
    expect(agentTuningForFamily("qwen").jsonNudge).toMatch(/JSON/i);
  });

  it("adds anti-refusal nudge for tiny qwen coder", () => {
    const tiny = agentTuningForFamily("qwen", "qwen2.5-coder-1.5b-ins.gguf");
    expect(tiny.rejectProseReasoning).toBe(true);
    expect(tiny.temperatureCap).toBeLessThanOrEqual(0.25);
    expect(tiny.jsonNudge).toMatch(/Не отказывайся/);
    const big = agentTuningForFamily("qwen", "Qwen2.5-Coder-7B-Instruct.gguf");
    expect(big.jsonNudge).not.toMatch(/Не отказывайся/);
  });
});

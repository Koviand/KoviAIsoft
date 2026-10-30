import { describe, expect, it } from "vitest";
import {
  agentTuningForFamily,
  detectModelFamily,
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

describe("agentTuningForFamily", () => {
  it("caps temperature for tool use", () => {
    expect(agentTuningForFamily("deepseek").temperatureCap).toBeLessThanOrEqual(0.35);
    expect(agentTuningForFamily("qwen").jsonNudge).toMatch(/JSON/i);
  });
});

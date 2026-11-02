import { describe, expect, it } from "vitest";
import {
  agentStepDetailRu,
  isSoftAgentStepDetail,
} from "../apps/ui/src/lib/labels";

describe("agent step UI details", () => {
  it("treats no tool / repair as soft (must not complete checklist)", () => {
    expect(isSoftAgentStepDetail("no tool")).toBe(true);
    expect(isSoftAgentStepDetail("repair")).toBe(true);
    expect(isSoftAgentStepDetail("final_blocked")).toBe(true);
    expect(isSoftAgentStepDetail("write_file ok")).toBe(false);
    // Plan freeze is soft — checklist advances via `plan` event, not step_done.
    expect(isSoftAgentStepDetail("План: 5 шагов")).toBe(true);
    expect(isSoftAgentStepDetail("identical tool")).toBe(true);
  });

  it("localizes no tool for the checklist", () => {
    expect(agentStepDetailRu("no tool")).toMatch(/не вызвала tool/i);
  });
});

import { describe, expect, it } from "vitest";
import { createDefaultSettings } from "../packages/shared/src/types";
import {
  buildToolConfirmation,
  evaluateToolConfirmNeed,
} from "../packages/core/src/agent/confirmGate";
import { riskForTool } from "../packages/core/src/tools/sandbox";
import {
  filterNetworkToolNames,
  internetAccessMode,
  internetDisabledMessage,
  isInternetEnabled,
  isNetworkTool,
  networkSearchNeedsConfirm,
} from "../packages/core/src/tools/internetAccess";

describe("internetAccessMode", () => {
  it("defaults to ask", () => {
    const s = createDefaultSettings("C:\\tmp\\kovi");
    expect(s.internetAccessMode).toBe("ask");
    expect(internetAccessMode(s)).toBe("ask");
    expect(isInternetEnabled(s)).toBe(true);
    expect(networkSearchNeedsConfirm(s)).toBe(true);
  });

  it("off disables network tools in filters", () => {
    const s = createDefaultSettings("C:\\tmp\\kovi");
    s.internetAccessMode = "off";
    expect(isInternetEnabled(s)).toBe(false);
    expect(filterNetworkToolNames(["web_search", "read_file", "browser_navigate"], s)).toEqual([
      "read_file",
    ]);
    expect(internetDisabledMessage("web_search")).toMatch(/выключен/i);
  });

  it("allow skips web_search confirm; ask always confirms", () => {
    const ask = createDefaultSettings("C:\\tmp\\kovi");
    ask.internetAccessMode = "ask";
    ask.agentRiskMode = "full";
    expect(
      evaluateToolConfirmNeed("web_search", { query: "погода Москва" }, ask, new Set()).needsConfirm,
    ).toBe(true);

    const allow = { ...ask, internetAccessMode: "allow" as const };
    expect(
      evaluateToolConfirmNeed("web_search", { query: "погода Москва" }, allow, new Set())
        .needsConfirm,
    ).toBe(false);

    // Remember for session skips further asks.
    expect(
      evaluateToolConfirmNeed(
        "web_search",
        { query: "новости" },
        ask,
        new Set(["web_search"]),
      ).needsConfirm,
    ).toBe(false);
  });

  it("classifies network tools", () => {
    expect(isNetworkTool("web_search")).toBe(true);
    expect(isNetworkTool("browser_navigate")).toBe(true);
    expect(isNetworkTool("read_file")).toBe(false);
    expect(riskForTool("web_search", { query: "x" })).toBe("medium");
  });

  it("NEVER_REMEMBER network tools set canRemember=false on confirmation payload", () => {
    const s = createDefaultSettings("C:\\tmp\\kovi");
    s.internetAccessMode = "ask";
    expect(
      evaluateToolConfirmNeed(
        "browser_navigate",
        { url: "https://example.com" },
        s,
        new Set(),
      ).needsConfirm,
    ).toBe(true);
    const payload = buildToolConfirmation({
      id: "c1",
      toolName: "browser_navigate",
      normalizedArgs: { url: "https://example.com" },
      risk: "high",
      settings: s,
    });
    expect(payload.canRemember).toBe(false);
  });
});

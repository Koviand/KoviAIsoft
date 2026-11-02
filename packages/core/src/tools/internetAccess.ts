import type { AppSettings, InternetAccessMode } from "@kovi/shared";

/** Built-in tools that reach the public internet. */
export const NETWORK_TOOL_NAMES = new Set([
  "web_search",
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_type",
]);

export function isNetworkTool(toolName: string): boolean {
  return NETWORK_TOOL_NAMES.has(toolName);
}

export function normalizeInternetAccessMode(raw: unknown): InternetAccessMode {
  if (raw === "off" || raw === "ask" || raw === "allow") return raw;
  return "ask";
}

export function internetAccessMode(settings: AppSettings): InternetAccessMode {
  return normalizeInternetAccessMode(settings.internetAccessMode);
}

/** False when network tools and chat live-web must not run. */
export function isInternetEnabled(settings: AppSettings): boolean {
  return internetAccessMode(settings) !== "off";
}

/**
 * web_search (and similar read-only net lookups) need an explicit confirm
 * when mode is «ask». browser_* mutations keep their own high-risk rules.
 */
export function networkSearchNeedsConfirm(settings: AppSettings): boolean {
  return internetAccessMode(settings) === "ask";
}

export function internetDisabledMessage(toolName?: string): string {
  const who = toolName ? `«${toolName}»` : "Сетевой инструмент";
  return (
    `${who} недоступен: доступ в интернет выключен в Настройках → Веб-поиск ` +
    `(режим «Выкл»). Включите «Спрашивать» или «Разрешить».`
  );
}

export function filterNetworkTools<T extends { name: string }>(
  tools: T[],
  settings: AppSettings,
): T[] {
  if (isInternetEnabled(settings)) return tools;
  return tools.filter((t) => !isNetworkTool(t.name));
}

export function filterNetworkToolNames(
  names: string[],
  settings: AppSettings,
): string[] {
  if (isInternetEnabled(settings)) return names;
  return names.filter((n) => !isNetworkTool(n));
}

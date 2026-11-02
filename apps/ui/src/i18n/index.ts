import { en } from "./en";
import { ru, type UiDict, type UiKey } from "./ru";

export type Lang = "ru" | "en";

const dicts: Record<Lang, UiDict> = { ru: { ...ru }, en };

let current: Lang = "ru";

export function setUiLanguage(lang: Lang): void {
  current = lang === "en" ? "en" : "ru";
}

export function getUiLanguage(): Lang {
  return current;
}

export function t(key: UiKey): string {
  return dicts[current][key] || dicts.ru[key] || String(key);
}

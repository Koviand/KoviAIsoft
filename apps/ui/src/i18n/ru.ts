export const ru = {
  tab_chat: "Чат",
  tab_models: "Модели",
  tab_runtime: "Движок",
  tab_settings: "Настройки",
  tab_mcp: "MCP",
  new_dialog: "Новый диалог",
  export: "Экспорт",
  pin: "Закрепить",
  unpin: "Открепить",
  continue: "Продолжить",
  pinned_only: "Только закреплённые",
  language: "Язык интерфейса",
  agent_safety: "Безопасность агента",
  web_search: "Веб-поиск",
  secrets_hint: "Секреты хранятся через OS safeStorage в desktop-сборке.",
} as const;

export type UiKey = keyof typeof ru;
export type UiDict = Record<UiKey, string>;

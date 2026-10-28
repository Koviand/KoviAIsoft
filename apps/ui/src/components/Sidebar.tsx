import type { ReactNode } from "react";
import type { AppView } from "@kovi/shared";
import { api } from "../api";

const ITEMS: Array<{ id: AppView; label: string; hint: string; icon: ReactNode }> = [
  {
    id: "chat",
    label: "Чат",
    hint: "Сообщения и агент",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7A2.5 2.5 0 0 1 17.5 16H10l-4 3.5V16H6.5A2.5 2.5 0 0 1 4 13.5v-7Z" />
      </svg>
    ),
  },
  {
    id: "models",
    label: "Модели",
    hint: "Загрузка GGUF",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 3 4 7.5v9L12 21l8-4.5v-9L12 3Z" />
        <path d="M12 12 4 7.5M12 12l8-4.5M12 12v9" />
      </svg>
    ),
  },
  {
    id: "runtime",
    label: "Runtime",
    hint: "Движок llama.cpp",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="4" y="5" width="16" height="14" rx="2" />
        <path d="M8 9h8M8 12h5M8 15h6" />
      </svg>
    ),
  },
  {
    id: "mcp",
    label: "MCP",
    hint: "Инструменты агента",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="7" cy="7" r="2.5" />
        <circle cx="17" cy="7" r="2.5" />
        <circle cx="12" cy="17" r="2.5" />
        <path d="M9.2 8.5 10.8 15M14.8 8.5 13.2 15M9.5 7h5" />
      </svg>
    ),
  },
  {
    id: "settings",
    label: "Настройки",
    hint: "Тема и папки",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="3" />
        <path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6.1 6.1l1.6 1.6M16.3 16.3l1.6 1.6M17.9 6.1l-1.6 1.6M7.7 16.3l-1.6 1.6" />
      </svg>
    ),
  },
];

const MONITOR_ICON = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="3.5" y="4.5" width="17" height="12" rx="2" />
    <path d="M8 20h8M12 16.5V20" />
    <path d="M7 9.5h4M7 12h7" />
  </svg>
);

export function Sidebar(props: { view: AppView; onChange: (v: AppView) => void }) {
  return (
    <aside className="sidebar">
      <button
        type="button"
        className="brand-mark"
        title="KoviAIsoft"
        onClick={() => props.onChange("chat")}
      >
        K
      </button>
      <nav className="nav" aria-label="Основная навигация">
        {ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={props.view === item.id ? "active" : ""}
            onClick={() => props.onChange(item.id)}
            aria-label={item.label}
            title={item.hint}
          >
            {item.icon}
            <span className="nav-tooltip">
              {item.label}
              <span className="muted" style={{ fontWeight: 500 }}>
                {" · "}
                {item.hint}
              </span>
            </span>
          </button>
        ))}
        <button
          type="button"
          className="nav-monitor"
          aria-label="Монитор"
          title="Отдельное окно монитора"
          onClick={() => void api.openMonitorWindow()}
        >
          {MONITOR_ICON}
          <span className="nav-tooltip">
            Монитор
            <span className="muted" style={{ fontWeight: 500 }}>
              {" · "}
              ресурсы и tok/s
            </span>
          </span>
        </button>
      </nav>
      <div className="sidebar-foot">v0.1</div>
    </aside>
  );
}

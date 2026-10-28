import type { AppView, StatusBarInfo } from "@kovi/shared";
import { api } from "../api";

const NAV: Array<{ id: AppView; label: string }> = [
  { id: "chat", label: "Чат" },
  { id: "models", label: "Модели" },
  { id: "runtime", label: "Runtime" },
  { id: "mcp", label: "MCP" },
  { id: "settings", label: "Настройки" },
];

export function Topbar(props: {
  view: AppView;
  onChange: (v: AppView) => void;
  status: StatusBarInfo | null;
  generating?: boolean;
  booting?: boolean;
  onStop?: () => void;
}) {
  const online = Boolean(props.status?.serverPort);
  const stateLabel = props.booting
    ? "загрузка…"
    : props.generating
      ? "генерация…"
      : online
        ? "сервер online"
        : "модель не загружена";

  return (
    <header className="topbar">
      <button type="button" className="brand" onClick={() => props.onChange("chat")}>
        <span className="brand-mark" aria-hidden="true">
          K
        </span>
        <span className="brand-name">
          Kovi<em>AI</em>soft
        </span>
      </button>

      <nav className="top-nav" aria-label="Разделы">
        {NAV.map((item) => (
          <button
            key={item.id}
            type="button"
            className={props.view === item.id ? "active" : ""}
            onClick={() => props.onChange(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <div className="topbar-meta">
        <span
          className={`status-dot ${props.generating ? "busy" : online ? "online" : ""}`}
          title={stateLabel}
        />
        <span className="topbar-model">{props.status?.modelName || "нет модели"}</span>
        <span className="topbar-state">{stateLabel}</span>
        {props.generating ? (
          <button
            type="button"
            className="btn topbar-stop"
            onClick={() => props.onStop?.()}
            title="Остановить генерацию"
          >
            Стоп
          </button>
        ) : null}
        <button
          type="button"
          className="btn ghost topbar-monitor"
          onClick={() => void api.openMonitorWindow()}
        >
          Монитор
        </button>
      </div>
    </header>
  );
}

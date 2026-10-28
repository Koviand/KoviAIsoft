import type { AppView, LocalModel, StatusBarInfo } from "@kovi/shared";
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
  models?: LocalModel[];
  onStop?: () => void;
  onLoadModel?: (modelId: string) => void;
}) {
  const online = Boolean(props.status?.serverPort);
  const tps = props.status?.tokensPerSecond;
  const agentStep = props.status?.agentStepLabel;
  const stateLabel = props.booting
    ? "загрузка…"
    : props.generating
      ? agentStep
        ? `агент · ${agentStep}`
        : "генерация…"
      : online
        ? tps != null && tps > 0
          ? `${tps} tok/s`
          : "сервер online"
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
        {(props.models?.length ?? 0) > 0 ? (
          <select
            className="topbar-model-select"
            value={props.status?.loadedModelId || ""}
            title="Быстрая смена модели"
            onChange={(e) => {
              const id = e.target.value;
              if (id) props.onLoadModel?.(id);
            }}
          >
            <option value="">модель…</option>
            {props.models!.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="topbar-model">{props.status?.modelName || "нет модели"}</span>
        )}
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

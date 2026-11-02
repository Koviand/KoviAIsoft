import { useMemo, useState } from "react";
import type { AppView, LocalModel, StatusBarInfo } from "@kovi/shared";
import { api } from "../api";
import { t } from "../i18n";

export function Topbar(props: {
  view: AppView;
  onChange: (v: AppView) => void;
  status: StatusBarInfo | null;
  generating?: boolean;
  booting?: boolean;
  models?: LocalModel[];
  onStop?: () => void;
  onLoadModel?: (modelId: string) => void;
  /** Bump when settings.language changes to refresh labels. */
  lang?: string;
}) {
  const [monitorError, setMonitorError] = useState<string | null>(null);
  const NAV = useMemo(
    () =>
      [
        { id: "chat" as const, label: t("tab_chat") },
        { id: "models" as const, label: t("tab_models") },
        { id: "runtime" as const, label: t("tab_runtime") },
        { id: "mcp" as const, label: t("tab_mcp") },
        { id: "settings" as const, label: t("tab_settings") },
      ] satisfies Array<{ id: AppView; label: string }>,
    [props.lang],
  );
  const online = Boolean(props.status?.serverPort);
  const tps = props.status?.tokensPerSecond;
  const agentStep = props.status?.agentStepLabel;
  const stateLabel = props.booting
    ? "загрузка…"
    : props.generating
      ? agentStep
        ? `процесс · ${agentStep}`
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
          title={monitorError || "Открыть монитор"}
          onClick={() => {
            setMonitorError(null);
            void api.openMonitorWindow().catch((e) => {
              setMonitorError(e instanceof Error ? e.message : String(e));
            });
          }}
        >
          Монитор
        </button>
        {monitorError ? (
          <span className="muted" style={{ fontSize: "0.72rem", maxWidth: 160 }} title={monitorError}>
            монитор: ошибка
          </span>
        ) : null}
      </div>
    </header>
  );
}

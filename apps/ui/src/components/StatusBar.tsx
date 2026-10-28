import type { StatusBarInfo } from "@kovi/shared";
import { api } from "../api";

/** Compact chip strip — full metrics live in the Monitor window. */
export function StatusBar({
  status,
  generating,
  booting,
}: {
  status: StatusBarInfo | null;
  generating?: boolean;
  booting?: boolean;
}) {
  if (booting || !status) {
    return (
      <footer className="status-bar status-bar-compact">
        <span className="status-dot" />
        <span className="muted">Загрузка…</span>
      </footer>
    );
  }
  const online = Boolean(status.serverPort);
  const stateLabel = generating ? "генерация…" : online ? "сервер online" : "модель не загружена";
  return (
    <footer className="status-bar status-bar-compact">
      <span
        className={`status-dot ${generating ? "busy" : online ? "online" : ""}`}
        title={stateLabel}
      />
      <span className="status-pill">{status.modelName || "нет модели"}</span>
      <span className={`status-pill ${generating ? "busy" : ""}`}>{stateLabel}</span>
      <button
        type="button"
        className="btn ghost status-monitor-btn"
        onClick={() => void api.openMonitorWindow()}
        title="Открыть окно с VRAM, tok/s и прогрессом загрузок"
      >
        Монитор
      </button>
    </footer>
  );
}

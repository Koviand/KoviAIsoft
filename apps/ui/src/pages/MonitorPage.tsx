import { useEffect, useState } from "react";
import type { MonitorSnapshot } from "@kovi/shared";
import { api } from "../api";
import { applyTheme } from "../hooks/useAppState";

function pct(used: number | null, total: number | null): number {
  if (used == null || total == null || total <= 0) return 0;
  return Math.min(100, Math.round((used / total) * 100));
}

function fmt(n: number | null, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

function monitorBridge() {
  if (typeof window !== "undefined" && window.koviMonitor) return window.koviMonitor;
  return api;
}

export function MonitorPage() {
  const [snap, setSnap] = useState<MonitorSnapshot | null>(null);
  const [alwaysOnTop, setAlwaysOnTop] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    // Monitor preload is restricted (no getSettings). Prefer dedicated bridge.
    const bridge = monitorBridge();
    if (typeof (api as { getSettings?: unknown }).getSettings === "function") {
      void api
        .getSettings()
        .then((s) => {
          if (alive) applyTheme(s.themePreset, s.themeCustom);
        })
        .catch(() => undefined);
    }
    const pull = async () => {
      try {
        const next = await bridge.getMonitorSnapshot();
        if (alive) {
          setSnap(next);
          setLoadError(null);
        }
      } catch (e) {
        if (alive) setLoadError(e instanceof Error ? e.message : String(e));
      }
    };
    void pull();
    // Prefer main-process push (1.5s) — avoid a second polling loop in the UI.
    const off = bridge.onMonitorUpdate((p) => {
      if (alive) {
        setSnap(p);
        setLoadError(null);
      }
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  const vramPct = pct(snap?.vramUsedGb ?? null, snap?.vramTotalGb ?? null);
  const ramPct = pct(snap?.ramUsedGb ?? null, snap?.ramTotalGb ?? null);
  const ctxPct = pct(snap?.contextUsed ?? null, snap?.contextSize ?? null);
  const gpuPct = snap?.gpuUtilPercent ?? 0;

  return (
    <div className="monitor-shell">
      <header className="monitor-header">
        <div>
          <div className="monitor-brand">Монитор</div>
          <div className="muted monitor-sub">
            {snap?.serverRunning ? "сервер работает" : "сервер выключен"}
            {snap?.busy ? " · идёт генерация" : ""}
          </div>
        </div>
        <button
          type="button"
          className={`btn ${alwaysOnTop ? "primary" : "ghost"}`}
          onClick={async () => {
            const next = !alwaysOnTop;
            try {
              const applied = await monitorBridge().setMonitorAlwaysOnTop(next);
              setAlwaysOnTop(applied);
            } catch (e) {
              setLoadError(e instanceof Error ? e.message : String(e));
            }
          }}
        >
          {alwaysOnTop ? "Поверх окон" : "Закрепить сверху"}
        </button>
      </header>

      <section className="monitor-hero">
        <div className="monitor-model">{snap?.modelName || "Модель не загружена"}</div>
        <div className="monitor-meta mono">
          runtime {snap?.runtimeTag || "—"} · {snap?.backend || "—"} · порт {snap?.serverPort ?? "—"}
        </div>
        {!snap?.serverRunning && (
          <p className="muted" style={{ margin: "8px 0 0", fontSize: "0.82rem" }}>
            Загрузите модель во вкладке «Модели», чтобы появились tok/s и контекст.
          </p>
        )}
      </section>

      <section className="monitor-grid">
        <Metric
          label="ток/с"
          value={fmt(snap?.tokensPerSecond ?? null)}
          hint={
            snap?.metricsSource && snap.metricsSource !== "none"
              ? `источник: ${snap.metricsSource}`
              : "ожидание генерации"
          }
        />
        <Metric
          label="prompt ток/с"
          value={fmt(snap?.promptTokensPerSecond ?? null)}
          hint="скорость разбора запроса"
        />
        <Metric
          label="контекст"
          value={
            snap?.contextUsed != null && snap?.contextSize != null
              ? `${snap.contextUsed}/${snap.contextSize}`
              : snap?.contextSize != null
                ? `—/${snap.contextSize}`
                : "—"
          }
          hint={`${ctxPct}% занято`}
          bar={ctxPct}
        />
        <Metric
          label="загрузка GPU"
          value={snap?.gpuUtilPercent != null ? `${snap.gpuUtilPercent}%` : "—"}
          bar={gpuPct}
        />
      </section>

      <section className="monitor-bars">
        <Bar
          label={`VRAM ${fmt(snap?.vramUsedGb ?? null)} / ${fmt(snap?.vramTotalGb ?? null)} GB`}
          value={vramPct}
        />
        <Bar
          label={`RAM ${fmt(snap?.ramUsedGb ?? null)} / ${fmt(snap?.ramTotalGb ?? null)} GB`}
          value={ramPct}
        />
      </section>

      {(snap?.runtimeDownloading ||
        ((snap?.runtimeProgress ?? 0) > 0 && (snap?.runtimeProgress ?? 0) < 100)) && (
        <section className="monitor-download">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <strong>Скачивание llama.cpp</strong>
            <span className="mono muted">{snap?.runtimeProgress ?? 0}%</span>
          </div>
          <div className="muted" style={{ marginTop: 4 }}>
            {snap?.runtimeLabel || "Скачивание…"}
          </div>
          <div className="progress" style={{ marginTop: 8 }}>
            <span style={{ width: `${snap?.runtimeProgress ?? 0}%` }} />
          </div>
        </section>
      )}

      {(snap?.modelDownloading ||
        ((snap?.modelProgress ?? 0) > 0 && (snap?.modelProgress ?? 0) < 100)) && (
        <section className="monitor-download">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <strong>Скачивание модели</strong>
            <span className="mono muted">{snap?.modelProgress ?? 0}%</span>
          </div>
          <div className="muted" style={{ marginTop: 4 }}>
            {snap?.modelLabel || "Скачивание…"}
          </div>
          <div className="progress" style={{ marginTop: 8 }}>
            <span style={{ width: `${snap?.modelProgress ?? 0}%` }} />
          </div>
        </section>
      )}

      {snap?.updateAvailable && (
        <div className="monitor-banner">
          Доступен runtime {snap.latestTag} (сейчас {snap.runtimeTag || "—"}). Откройте «Движок» →
          «Установить сейчас».
        </div>
      )}

      {(snap?.lastError || loadError) && (
        <div className="monitor-error">{snap?.lastError || loadError}</div>
      )}

      <footer className="monitor-foot muted mono">
        последняя проверка runtime:{" "}
        {snap?.runtimeLastCheckAt ? new Date(snap.runtimeLastCheckAt).toLocaleString() : "ещё не было"}
      </footer>
    </div>
  );
}

function Metric(props: {
  label: string;
  value: string;
  hint?: string;
  bar?: number;
}) {
  return (
    <div className="monitor-metric">
      <div className="monitor-metric-label">{props.label}</div>
      <div className="monitor-metric-value">{props.value}</div>
      {props.hint ? (
        <div className="muted" style={{ fontSize: "0.7rem" }}>
          {props.hint}
        </div>
      ) : null}
      {typeof props.bar === "number" ? (
        <div className="progress" style={{ marginTop: 8 }}>
          <span style={{ width: `${props.bar}%` }} />
        </div>
      ) : null}
    </div>
  );
}

function Bar(props: { label: string; value: number }) {
  return (
    <div className="monitor-bar-block">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span>{props.label}</span>
        <span className="mono muted">{props.value}%</span>
      </div>
      <div className="progress" style={{ marginTop: 8 }}>
        <span style={{ width: `${props.value}%` }} />
      </div>
    </div>
  );
}

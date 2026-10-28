import { useEffect, useState } from "react";
import type {
  RuntimeAsset,
  RuntimeBackend,
  RuntimeStatus,
  RuntimeUpdateInfo,
  SystemInfo,
} from "@kovi/shared";
import { api } from "../api";

export function RuntimePage(props: {
  system: SystemInfo | null;
  runtime: RuntimeStatus | null;
  setError: (e: string | null) => void;
  refresh: () => Promise<void>;
}) {
  const [asset, setAsset] = useState<RuntimeAsset | null>(null);
  const [backend, setBackend] = useState<RuntimeBackend | "auto">("auto");
  const [update, setUpdate] = useState<RuntimeUpdateInfo | null>(null);
  const [progress, setProgress] = useState<{ progress: number; label: string } | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    return api.onRuntimeProgress(setProgress);
  }, []);

  useEffect(() => {
    void api
      .checkRuntimeUpdate(backend)
      .then((info) => {
        setUpdate(info);
        if (info.latestAsset) setAsset(info.latestAsset);
      })
      .catch(() => undefined);
  }, [backend]);

  useEffect(() => {
    if (props.runtime?.update) setUpdate(props.runtime.update);
  }, [props.runtime?.update]);

  async function detect(): Promise<void> {
    setWorking(true);
    try {
      const info = await api.checkRuntimeUpdate(backend);
      setUpdate(info);
      setAsset(info.latestAsset);
    } catch (e) {
      props.setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  }

  async function installLatest(): Promise<void> {
    setWorking(true);
    props.setError(null);
    try {
      const result = await api.ensureLatestRuntime(backend, true);
      setUpdate(result.update);
      setAsset(result.update.latestAsset);
      await props.refresh();
    } catch (e) {
      props.setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
      setProgress(null);
    }
  }

  async function unload(): Promise<void> {
    setWorking(true);
    try {
      await api.unloadModel();
      await props.refresh();
    } catch (e) {
      props.setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  }

  function updateStatusLabel(): string {
    if (!update) return "Статус обновления ещё не получен";
    if (update.updateAvailable) {
      return `Есть обновление: ${update.currentTag || "?"} → ${update.latestTag}`;
    }
    return update.message || `Актуально: ${update.latestTag || "—"}`;
  }

  return (
    <div className="stack-page">
      <header className="page-header">
        <div className="row" style={{ justifyContent: "space-between", width: "100%" }}>
          <div>
            <h1 className="h1">Runtime (llama.cpp)</h1>
            <p className="muted page-sub">
              Движок инференса. Автопроверка обновлений не чаще раза в сутки
            </p>
          </div>
          <button className="btn" type="button" onClick={() => void api.openMonitorWindow()}>
            Открыть монитор
          </button>
        </div>
      </header>

      <div className="grid-2">
        <section className="card elevated">
          <h3>Ваше железо</h3>
          {props.system ? (
            <div className="mono" style={{ fontSize: "0.85rem", lineHeight: 1.7, marginTop: 10 }}>
              <div>
                {props.system.os} · {props.system.arch}
              </div>
              <div>
                {props.system.cpuModel} ({props.system.cpuCores} ядер)
              </div>
              <div>
                RAM свободно {props.system.freeRamGb}/{props.system.totalRamGb} GB
              </div>
              <div>
                NVIDIA: {props.system.hasNvidia ? "да" : "нет"}
                {props.system.cudaVersion ? ` (CUDA ${props.system.cudaVersion})` : ""}
              </div>
              <div>Vulkan: {props.system.hasVulkan ? "да" : "нет"}</div>
              <div>Рекомендуемый backend: {props.system.recommendedBackend}</div>
              {props.system.gpus.map((g) => (
                <div key={g.index}>
                  GPU{g.index}: {g.name}
                  {g.vramGb ? ` · ${g.vramGb.toFixed(1)} GB` : ""}
                </div>
              ))}
            </div>
          ) : (
            <div className="muted" style={{ marginTop: 10 }}>
              Нет данных о системе
            </div>
          )}
        </section>

        <section className="card elevated">
          <h3>Установка и обновление</h3>
          <p className="muted" style={{ marginTop: 8, marginBottom: 0 }}>
            Программа сама подтягивает свежий llama.cpp с GitHub (не чаще 24 часов). Кнопка ниже —
            принудительная установка.
          </p>
          <div className="row" style={{ marginTop: 12 }}>
            <select
              className="select"
              style={{ width: 160 }}
              value={backend}
              disabled={working}
              onChange={(e) => setBackend(e.target.value as RuntimeBackend | "auto")}
            >
              <option value="auto">auto (рекомендуется)</option>
              <option value="cuda">cuda</option>
              <option value="vulkan">vulkan</option>
              <option value="cpu">cpu</option>
            </select>
            <button className="btn" type="button" disabled={working} onClick={() => void detect()}>
              Проверить обновления
            </button>
            <button
              className="btn primary"
              type="button"
              disabled={working}
              onClick={() => void installLatest()}
            >
              Установить сейчас
            </button>
            <button className="btn" type="button" disabled={working} onClick={() => void unload()}>
              Выгрузить модель
            </button>
          </div>

          {update && (
            <div
              className="section-block"
              style={{
                borderColor: update.updateAvailable
                  ? "color-mix(in srgb, var(--warning) 55%, var(--border))"
                  : undefined,
              }}
            >
              <div className="mono" style={{ fontSize: "0.85rem", lineHeight: 1.55 }}>
                <div>{updateStatusLabel()}</div>
                <div>у вас: {update.currentTag || "не установлен"}</div>
                <div>на GitHub: {update.latestTag || "—"}</div>
                {update.checkedAt && (
                  <div className="muted">проверка: {new Date(update.checkedAt).toLocaleString()}</div>
                )}
              </div>
            </div>
          )}

          {asset && (
            <div className="mono section-block" style={{ fontSize: "0.85rem", lineHeight: 1.55 }}>
              <div>тег: {asset.tag}</div>
              <div>backend: {asset.backend}</div>
              <div>файл: {asset.assetName}</div>
              {asset.cudartAssetName && <div>cudart: {asset.cudartAssetName}</div>}
            </div>
          )}

          {(progress || props.runtime?.downloading) && (
            <div style={{ marginTop: 14 }}>
              <div className="muted">
                {progress?.label || props.runtime?.downloadLabel || "Скачивание…"}
              </div>
              <div className="progress">
                <span
                  style={{
                    width: `${progress?.progress ?? props.runtime?.downloadProgress ?? 0}%`,
                  }}
                />
              </div>
            </div>
          )}

          <div className="mono section-block" style={{ fontSize: "0.85rem", lineHeight: 1.55 }}>
            <div>
              Установлен:{" "}
              {props.runtime?.installed
                ? `${props.runtime.installed.tag} / ${props.runtime.installed.backend}`
                : "нет"}
            </div>
            <div>
              Сервер:{" "}
              {props.runtime?.serverRunning
                ? `работает, порт ${props.runtime.serverPort}`
                : "выключен"}
            </div>
            {props.runtime?.lastError && (
              <div style={{ color: "var(--danger)", marginTop: 8 }}>{props.runtime.lastError}</div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

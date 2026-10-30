import { useEffect, useState } from "react";
import type {
  AppSettings,
  CodebaseIndexStatus,
  EmbeddingModelId,
  EmbeddingModelInfo,
  RuntimeAsset,
  RuntimeBackend,
  RuntimeStatus,
  RuntimeUpdateInfo,
  SystemInfo,
} from "@kovi/shared";
import { api } from "../api";
import { PageShell, SettingsSection } from "../components/PageShell";

const EMBED_OPTIONS: Array<{
  id: EmbeddingModelId;
  title: string;
  blurb: string;
}> = [
  {
    id: "minilm",
    title: "MiniLM — быстро и легко",
    blurb: "Для поиска по коду (@codebase). Мало памяти, dim 384, работает на CPU.",
  },
  {
    id: "lfm25",
    title: "LFM2.5 — точнее",
    blurb: "Лучше качество поиска. Нужен llama.cpp и больше RAM, dim 1024.",
  },
];

const RUNTIME_NAV = [
  { id: "hardware", label: "Это ПК", group: "Система" },
  { id: "llama", label: "llama.cpp", group: "Система" },
  { id: "codebase", label: "Поиск по коду", group: "Индекс" },
] as const;

export function RuntimePage(props: {
  system: SystemInfo | null;
  runtime: RuntimeStatus | null;
  settings: AppSettings | null;
  setSettings: (s: AppSettings) => void;
  setError: (e: string | null) => void;
  refresh: () => Promise<void>;
}) {
  const [asset, setAsset] = useState<RuntimeAsset | null>(null);
  const [backend, setBackend] = useState<RuntimeBackend | "auto">("auto");
  const [update, setUpdate] = useState<RuntimeUpdateInfo | null>(null);
  const [progress, setProgress] = useState<{ progress: number; label: string } | null>(null);
  const [working, setWorking] = useState(false);
  const [embedModels, setEmbedModels] = useState<EmbeddingModelInfo[]>([]);
  const [embedBusyId, setEmbedBusyId] = useState<EmbeddingModelId | null>(null);
  const [indexStatus, setIndexStatus] = useState<CodebaseIndexStatus | null>(null);
  const [indexBusy, setIndexBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

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

  useEffect(() => {
    void api
      .getEmbeddingStatus()
      .then((st) => setEmbedModels(st.models))
      .catch(() => undefined);
    void api
      .getCodebaseIndexStatus()
      .then(setIndexStatus)
      .catch(() => undefined);
  }, [props.settings?.embeddingModelId, props.settings?.projectRoot]);

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

  const s = props.settings;

  return (
    <PageShell
      title="Движок"
      subtitle="llama.cpp для чата и модели поиска по коду (@codebase)"
      actions={
        <button className="btn" type="button" onClick={() => void api.openMonitorWindow()}>
          Монитор
        </button>
      }
      nav={[...RUNTIME_NAV]}
    >
      {hint && (
        <div className="status-strip" role="status">
          {hint}
        </div>
      )}

      <SettingsSection
        id="hardware"
        title="Это ПК"
        description="По железу выбирается backend (CUDA / Vulkan / CPU)."
        elevated
      >
        {props.system ? (
          <dl className="kv-list">
            <dt>ОС</dt>
            <dd>
              {props.system.os} · {props.system.arch}
            </dd>
            <dt>CPU</dt>
            <dd>
              {props.system.cpuModel} ({props.system.cpuCores} ядер)
            </dd>
            <dt>RAM</dt>
            <dd>
              свободно {props.system.freeRamGb}/{props.system.totalRamGb} GB
            </dd>
            <dt>NVIDIA</dt>
            <dd>
              {props.system.hasNvidia ? "да" : "нет"}
              {props.system.cudaVersion ? ` · CUDA ${props.system.cudaVersion}` : ""}
            </dd>
            <dt>Vulkan</dt>
            <dd>{props.system.hasVulkan ? "да" : "нет"}</dd>
            <dt>рекоменд.</dt>
            <dd>{props.system.recommendedBackend}</dd>
            {props.system.gpus.map((g) => (
              <div key={g.index} style={{ display: "contents" }}>
                <dt>GPU{g.index}</dt>
                <dd>
                  {g.name}
                  {g.vramGb ? ` · ${g.vramGb.toFixed(1)} GB` : ""}
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <div className="muted">Нет данных о системе</div>
        )}
      </SettingsSection>

      <SettingsSection
        id="llama"
        title="llama.cpp — чат и агент"
        description="Нужен для ответов модели. Обычно ставится сам; ниже — установка с GitHub."
        elevated
      >
        <div className="status-strip">
          <span>
            Установлен:{" "}
            <strong className="mono">
              {props.runtime?.installed
                ? `${props.runtime.installed.tag} / ${props.runtime.installed.backend}`
                : "нет"}
            </strong>
          </span>
          <span>
            Сервер:{" "}
            <strong className="mono">
              {props.runtime?.serverRunning
                ? `порт ${props.runtime.serverPort}`
                : "выключен"}
            </strong>
          </span>
        </div>

        <div className="toolbar-row">
          <select
            className="select"
            style={{ width: 200 }}
            value={backend}
            disabled={working}
            onChange={(e) => setBackend(e.target.value as RuntimeBackend | "auto")}
            title="Какой тип сборки llama.cpp ставить"
          >
            <option value="auto">Авто (рекомендуется)</option>
            <option value="cuda">CUDA (NVIDIA)</option>
            <option value="vulkan">Vulkan</option>
            <option value="cpu">Только CPU</option>
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
            Установить / обновить
          </button>
          <button className="btn" type="button" disabled={working} onClick={() => void unload()}>
            Выгрузить модель
          </button>
        </div>

        {update && (
          <dl className="kv-list">
            <dt>статус</dt>
            <dd>{updateStatusLabel()}</dd>
            <dt>у вас</dt>
            <dd>{update.currentTag || "не установлен"}</dd>
            <dt>GitHub</dt>
            <dd>{update.latestTag || "—"}</dd>
            {update.checkedAt && (
              <>
                <dt>проверка</dt>
                <dd>{new Date(update.checkedAt).toLocaleString()}</dd>
              </>
            )}
          </dl>
        )}

        {asset && (
          <dl className="kv-list">
            <dt>тег</dt>
            <dd>{asset.tag}</dd>
            <dt>backend</dt>
            <dd>{asset.backend}</dd>
            <dt>файл</dt>
            <dd>{asset.assetName}</dd>
            {asset.cudartAssetName && (
              <>
                <dt>cudart</dt>
                <dd>{asset.cudartAssetName}</dd>
              </>
            )}
          </dl>
        )}

        {(progress || props.runtime?.downloading) && (
          <div>
            <div className="muted" style={{ marginBottom: 6 }}>
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

        {!props.runtime?.serverRunning && (
          <p className="field-hint">Сервер запустится, когда загрузите модель на вкладке «Модели».</p>
        )}
        {props.runtime?.lastError && (
          <div style={{ color: "var(--danger)", fontSize: "0.85rem" }}>{props.runtime.lastError}</div>
        )}

        {s && (
          <div className="section-block" style={{ marginTop: 0 }}>
            <label className="row">
              <input
                type="checkbox"
                checked={s.autoUpdateRuntime !== false}
                onChange={(e) => {
                  const next = { ...s, autoUpdateRuntime: e.target.checked };
                  props.setSettings(next);
                  void api.saveSettings(next).then(props.setSettings).catch((err) => {
                    props.setError(err instanceof Error ? err.message : String(err));
                  });
                }}
              />
              Самой проверять обновления llama.cpp (не чаще раза в сутки)
            </label>
            <label className="field" style={{ marginTop: 12 }}>
              <span className="field-label">GitHub Token</span>
              <input
                className="input"
                type="password"
                autoComplete="off"
                placeholder="ghp_… — меньше лимитов API"
                value={s.githubToken === "__secure__" ? "" : s.githubToken || ""}
                onChange={(e) => {
                  const next = { ...s, githubToken: e.target.value };
                  props.setSettings(next);
                  void api.saveSettings(next).then(props.setSettings).catch(() => undefined);
                }}
              />
              <span className="muted" style={{ display: "block", marginTop: 6, fontSize: "0.78rem" }}>
                В desktop-сборке токен по возможности хранится через OS safeStorage, не в открытом
                settings.json. Для git push нужна отдельная авторизация (`gh auth login` / SSH).
              </span>
            </label>
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        id="codebase"
        title="Поиск по коду (@codebase)"
        description={
          <>
            Модель эмбеддингов строит индекс проекта. В чате — <code>@codebase</code>. Смена модели
            пересобирает индекс. Папка проекта — в «Настройках».
          </>
        }
      >
        {!s?.projectRoot && (
          <div className="status-strip" style={{ borderColor: "color-mix(in srgb, var(--warning) 45%, var(--border))" }}>
            Сначала укажите папку проекта в Настройках — иначе индекс некуда строить.
          </div>
        )}

        <div className="option-grid">
          {EMBED_OPTIONS.map((opt) => {
            const info = embedModels.find((m) => m.id === opt.id);
            const active = (s?.embeddingModelId || "minilm") === opt.id;
            const installed = Boolean(info?.installed);
            const busy = embedBusyId === opt.id || (indexBusy && active);
            return (
              <div key={opt.id} className={`option-card ${active ? "on" : ""}`}>
                <div className="option-card-title">{opt.title}</div>
                <div className="muted" style={{ fontSize: "0.78rem" }}>
                  {opt.blurb}
                </div>
                <div className="option-card-meta">
                  {installed ? "скачана" : "не скачана"}
                  {info?.ready === false && info?.error
                    ? ` · ошибка: ${info.error}`
                    : info?.error
                      ? ` · ${info.error}`
                      : ""}
                  {active ? " · используется" : ""}
                </div>
                <div className="toolbar-row">
                  <button
                    type="button"
                    className="btn"
                    disabled={installed || embedBusyId !== null}
                    onClick={() => {
                      setEmbedBusyId(opt.id);
                      void api
                        .downloadEmbeddingModel(opt.id)
                        .then(() => {
                          void api.getEmbeddingStatus().then((st) => setEmbedModels(st.models));
                          setHint(`Скачано: ${opt.title}`);
                        })
                        .catch((e) =>
                          props.setError(e instanceof Error ? e.message : String(e)),
                        )
                        .finally(() => setEmbedBusyId(null));
                    }}
                  >
                    {busy && !active ? "Скачивание…" : installed ? "Уже скачана" : "Скачать"}
                  </button>
                  <button
                    type="button"
                    className={`btn ${active ? "primary" : ""}`}
                    disabled={!s || active || embedBusyId !== null || indexBusy}
                    onClick={() => {
                      setEmbedBusyId(opt.id);
                      setIndexBusy(true);
                      void api
                        .setEmbeddingModel(opt.id)
                        .then((res) => {
                          props.setSettings(res.settings);
                          setEmbedModels(res.status.models);
                          setIndexStatus(res.index);
                          setHint(
                            res.index.error
                              ? `Индекс: ${res.index.error}`
                              : `Выбрано: ${opt.title} · ${res.index.chunkCount} фрагментов`,
                          );
                        })
                        .catch((e) =>
                          props.setError(e instanceof Error ? e.message : String(e)),
                        )
                        .finally(() => {
                          setEmbedBusyId(null);
                          setIndexBusy(false);
                        });
                    }}
                  >
                    {busy && active ? "Включение…" : active ? "Выбрана" : "Использовать"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <div className="toolbar-row">
          <button
            type="button"
            className="btn"
            disabled={!s?.projectRoot || indexBusy}
            onClick={() => {
              setIndexBusy(true);
              void api
                .reindexCodebase()
                .then((st) => {
                  setIndexStatus(st);
                  setHint(
                    st.error
                      ? `Индекс: ${st.error}`
                      : `Индекс готов: ${st.chunkCount} фрагментов кода`,
                  );
                })
                .catch((e) => props.setError(e instanceof Error ? e.message : String(e)))
                .finally(() => setIndexBusy(false));
            }}
          >
            {indexBusy ? "Индексация…" : "Пересобрать индекс проекта"}
          </button>
          {indexStatus && (
            <span className="muted mono" style={{ fontSize: "0.78rem" }}>
              {indexStatus.indexing
                ? "строится…"
                : indexStatus.ready
                  ? `готов · ${indexStatus.chunkCount} фрагментов`
                  : indexStatus.error || "индекса ещё нет"}
            </span>
          )}
        </div>
      </SettingsSection>
    </PageShell>
  );
}

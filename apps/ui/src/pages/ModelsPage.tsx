import { useEffect, useState } from "react";
import type {
  AppSettings,
  HfFile,
  HfSearchResult,
  LocalModel,
  ModelPerfTier,
  ModelRecommendation,
  ModelRecommendationsReport,
} from "@kovi/shared";
import { api } from "../api";

function fmtGb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function tierLabel(tier: ModelPerfTier): string {
  switch (tier) {
    case "excellent":
      return "Отлично";
    case "good":
      return "Хорошо";
    case "tight":
      return "Впритык";
    case "cpu":
      return "CPU/RAM";
    case "too_heavy":
      return "Тяжело";
  }
}

function tierClass(tier: ModelPerfTier): string {
  return `badge tier-${tier}`;
}

export function ModelsPage(props: {
  models: LocalModel[];
  loadedModelId: string | null;
  settings: AppSettings | null;
  setModels: (m: LocalModel[]) => void;
  setSettings: (s: AppSettings) => void;
  setError: (e: string | null) => void;
  refresh: () => Promise<void>;
}) {
  const [query, setQuery] = useState("LFM2 GGUF");
  const [hf, setHf] = useState<HfSearchResult[]>([]);
  const [files, setFiles] = useState<HfFile[]>([]);
  const [selectedHf, setSelectedHf] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ progress: number; label: string } | null>(null);
  const [working, setWorking] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [recs, setRecs] = useState<ModelRecommendationsReport | null>(null);
  const [recsLoading, setRecsLoading] = useState(false);

  async function loadRecommendations(): Promise<void> {
    setRecsLoading(true);
    try {
      setRecs(await api.getModelRecommendations());
    } catch (e) {
      props.setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRecsLoading(false);
    }
  }

  useEffect(() => {
    void loadRecommendations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function scan(): Promise<void> {
    setWorking(true);
    setHint(null);
    try {
      props.setModels(await api.scanModels());
      setHint("Список локальных моделей обновлён");
      await loadRecommendations();
    } catch (e) {
      props.setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  }

  async function search(): Promise<void> {
    setWorking(true);
    setHint(null);
    try {
      setHf(await api.searchHf(query));
      setFiles([]);
      setSelectedHf(null);
    } catch (e) {
      props.setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  }

  async function openRepo(id: string): Promise<void> {
    setSelectedHf(id);
    setWorking(true);
    try {
      setFiles(await api.listHfFiles(id));
      setQuery(id);
    } catch (e) {
      props.setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  }

  async function openRecommendation(item: ModelRecommendation): Promise<void> {
    setHint(`Открываю ${item.hfRepo} — ищите файл *${item.suggestedQuant}*`);
    setQuery(item.hfRepo);
    await openRepo(item.hfRepo);
  }

  async function download(filePath: string): Promise<void> {
    if (!selectedHf) return;
    setWorking(true);
    setHint(null);
    const off = api.onDownloadProgress(setProgress);
    try {
      await api.downloadHfFile(selectedHf, filePath);
      props.setModels(await api.scanModels());
      const s = await api.getSettings();
      props.setSettings(s);
      setHint("Файл скачан. Можно нажать «Загрузить в память».");
      void api.openMonitorWindow().catch(() => undefined);
    } catch (e) {
      props.setError(e instanceof Error ? e.message : String(e));
    } finally {
      off();
      setProgress(null);
      setWorking(false);
    }
  }

  async function load(modelId: string, name: string): Promise<void> {
    setWorking(true);
    setHint(`Загрузка «${name}» в llama-server…`);
    try {
      await api.loadModel(modelId);
      await props.refresh();
      setHint(`«${name}» загружена — можно писать в чате`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setHint(msg);
      props.setError(msg);
    } finally {
      setWorking(false);
    }
  }

  async function verify(modelId: string): Promise<void> {
    setWorking(true);
    try {
      const next = await api.verifyGguf(modelId);
      props.setModels(props.models.map((m) => (m.id === modelId ? next : m)));
      setHint(
        next.integrityOk
          ? `GGUF OK: ${next.name}`
          : `Проблема GGUF: ${next.integrityError || "ошибка"}`,
      );
      if (!next.integrityOk) props.setError(next.integrityError || "GGUF повреждён");
    } catch (e) {
      props.setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  }

  async function setProfile(id: string): Promise<void> {
    if (!props.settings) return;
    try {
      const saved = await api.saveSettings({ ...props.settings, activeLoadProfileId: id });
      props.setSettings(saved);
    } catch (e) {
      props.setError(e instanceof Error ? e.message : String(e));
    }
  }

  const profiles = props.settings?.loadProfiles || [];
  const activeProfileId = props.settings?.activeLoadProfileId;
  const topRecs = (recs?.items || []).filter((i) => i.tier !== "too_heavy").slice(0, 8);

  return (
    <div className="stack-page">
      <header className="page-header">
        <div className="row" style={{ justifyContent: "space-between", width: "100%" }}>
          <div>
            <h1 className="h1">Модели</h1>
            <p className="muted page-sub">
              Рекомендации под ваше железо, локальные GGUF и загрузка с Hugging Face
            </p>
          </div>
          <button className="btn" type="button" disabled={working} onClick={() => void scan()}>
            Обновить список
          </button>
        </div>
      </header>

      <section className="card elevated recommend-card">
        <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <div>
            <h3 style={{ margin: 0 }}>Что скачать на этот ПК</h3>
            <p className="muted" style={{ margin: "6px 0 0", fontSize: "0.82rem" }}>
              {recsLoading && !recs
                ? "Считаем рекомендации…"
                : recs?.summary || "Нажмите «Пересчитать», чтобы оценить модели под VRAM/RAM."}
            </p>
          </div>
          <button
            className="btn ghost"
            type="button"
            disabled={recsLoading || working}
            onClick={() => void loadRecommendations()}
          >
            Пересчитать
          </button>
        </div>
        {recs && (
          <div className="muted mono" style={{ fontSize: "0.78rem", marginTop: 8 }}>
            {recs.gpuName ? `GPU: ${recs.gpuName}` : "GPU не обнаружен"}
            {recs.vramGb != null ? ` · VRAM ${recs.vramGb.toFixed(1)} GB` : ""}
            {` · RAM ${recs.ramGb.toFixed(0)} GB · backend ${recs.backend}`}
          </div>
        )}
        <div className="recommend-grid" style={{ marginTop: 12 }}>
          {topRecs.map((item) => (
            <div key={item.id} className="recommend-item">
              <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
                <strong>{item.name}</strong>
                <span className={tierClass(item.tier)}>{tierLabel(item.tier)}</span>
              </div>
              <div className="muted" style={{ fontSize: "0.8rem", marginTop: 4 }}>
                {item.description}
              </div>
              <div className="mono" style={{ fontSize: "0.78rem", marginTop: 8 }}>
                {item.suggestedQuant} ≈ {fmtGb(item.approxSizeBytes)} · ctx {item.recommendedContext}
                {item.fitsInVram ? ` · ngl ${item.recommendedNgl}` : " · offload/CPU"}
              </div>
              <div className="muted" style={{ fontSize: "0.78rem", marginTop: 6 }}>
                {item.verdict}
              </div>
              <div className="muted" style={{ fontSize: "0.75rem", marginTop: 4 }}>
                {item.expectedSpeed}
              </div>
              <div className="row" style={{ marginTop: 10, flexWrap: "wrap" }}>
                {item.tags.slice(0, 3).map((t) => (
                  <span key={t} className="badge">
                    {t}
                  </span>
                ))}
              </div>
              <button
                className="btn primary"
                type="button"
                style={{ marginTop: 10 }}
                disabled={working}
                onClick={() => void openRecommendation(item)}
              >
                Открыть на HF
              </button>
            </div>
          ))}
          {!recsLoading && topRecs.length === 0 && (
            <div className="muted">Нет подходящих вариантов в каталоге.</div>
          )}
        </div>
      </section>

      {profiles.length > 0 && (
        <section className="card">
          <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
            <strong>Профиль загрузки</strong>
            <div className="row" style={{ flexWrap: "wrap" }}>
              {profiles.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`btn ${activeProfileId === p.id ? "primary" : "ghost"}`}
                  disabled={working}
                  onClick={() => void setProfile(p.id)}
                >
                  {p.name}
                </button>
              ))}
            </div>
          </div>
        </section>
      )}

      {hint && (
        <div className="page-hint" role="status">
          {hint}
        </div>
      )}

      <div className="grid-2">
        <section className="card elevated">
          <h3>На этом компьютере</h3>
          <p className="muted" style={{ margin: "6px 0 0", fontSize: "0.82rem" }}>
            ngl / ctx — оценка под VRAM. Красный статус — битый GGUF.
          </p>
          <div className="stack" style={{ maxHeight: 420, marginTop: 10 }}>
            {props.models.map((m) => {
              const loaded = props.loadedModelId === m.id;
              return (
                <div key={m.id} className="list-item model-row" style={{ padding: "12px 10px" }}>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <strong>{m.name}</strong>
                    <span className="row">
                      {m.integrityOk === false ? (
                        <span className="badge badge-danger">битый GGUF</span>
                      ) : null}
                      {m.fitsInVram === true ? (
                        <span className="badge tier-good">в VRAM</span>
                      ) : null}
                      {m.fitsInVram === false ? (
                        <span className="badge tier-tight">offload</span>
                      ) : null}
                      {loaded ? <span className="badge">в памяти</span> : null}
                    </span>
                  </div>
                  <div className="muted mono" style={{ fontSize: "0.8rem", marginTop: 4 }}>
                    {fmtGb(m.sizeBytes)} · {m.quant || "квант ?"} · ngl {m.recommendedNgl} · ctx{" "}
                    {m.recommendedContext}
                    {m.mmprojPath ? " · есть vision (mmproj)" : ""}
                    {m.fitsInVram === false ? " · может не влезть целиком в VRAM" : ""}
                    {m.integrityOk === false && m.integrityError ? ` · ${m.integrityError}` : ""}
                  </div>
                  <div className="row" style={{ marginTop: 10 }}>
                    <button
                      className="btn primary"
                      type="button"
                      disabled={working || m.integrityOk === false}
                      onClick={() => void load(m.id, m.name)}
                    >
                      {loaded ? "Перезагрузить" : "Загрузить в память"}
                    </button>
                    <button
                      className="btn ghost"
                      type="button"
                      disabled={working}
                      onClick={() => void verify(m.id)}
                    >
                      Проверить GGUF
                    </button>
                  </div>
                </div>
              );
            })}
            {props.models.length === 0 && (
              <div className="muted">
                Модели не найдены. Выберите рекомендацию выше или скачайте справа.
              </div>
            )}
          </div>
        </section>

        <section className="card elevated">
          <h3>Скачать с Hugging Face</h3>
          <div className="row" style={{ marginTop: 10 }}>
            <input
              className="input"
              value={query}
              disabled={working}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void search();
              }}
              placeholder="Поиск или id репозитория"
            />
            <button className="btn primary" type="button" disabled={working} onClick={() => void search()}>
              Найти
            </button>
          </div>
          {progress && (
            <div style={{ marginTop: 12 }}>
              <div className="muted">{progress.label}</div>
              <div className="progress">
                <span style={{ width: `${progress.progress}%` }} />
              </div>
            </div>
          )}
          <div className="stack" style={{ maxHeight: 200, marginTop: 12 }}>
            {hf.map((r) => (
              <button
                key={r.id}
                type="button"
                className={`list-item ${selectedHf === r.id ? "active" : ""}`}
                style={{ padding: "10px" }}
                disabled={working}
                onClick={() => void openRepo(r.id)}
              >
                <div>{r.modelId}</div>
                <div className="muted" style={{ fontSize: "0.75rem" }}>
                  скачиваний {r.downloads} · лайков {r.likes}
                </div>
              </button>
            ))}
          </div>
          {selectedHf && (
            <div className="section-block">
              <strong>Файлы {selectedHf}</strong>
              <p className="muted" style={{ fontSize: "0.78rem", margin: "4px 0 0" }}>
                ★ — рекомендуемый файл под ваше железо
              </p>
              {files.map((f) => (
                <div
                  key={f.path}
                  className="row"
                  style={{ marginTop: 8, justifyContent: "space-between" }}
                >
                  <span className="mono" style={{ fontSize: "0.8rem" }}>
                    {f.path} ({fmtGb(f.size)}){f.recommended ? " ★" : ""}
                  </span>
                  <button
                    className="btn"
                    type="button"
                    disabled={working}
                    onClick={() => void download(f.path)}
                  >
                    Скачать
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

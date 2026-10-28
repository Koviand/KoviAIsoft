import { useState } from "react";
import type { AppSettings, HfFile, HfSearchResult, LocalModel } from "@kovi/shared";
import { api } from "../api";

function fmtGb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
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
  const [query, setQuery] = useState("LFM3 GGUF");
  const [hf, setHf] = useState<HfSearchResult[]>([]);
  const [files, setFiles] = useState<HfFile[]>([]);
  const [selectedHf, setSelectedHf] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ progress: number; label: string } | null>(null);
  const [working, setWorking] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  async function scan(): Promise<void> {
    setWorking(true);
    setHint(null);
    try {
      props.setModels(await api.scanModels());
      setHint("Список локальных моделей обновлён");
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
    } catch (e) {
      props.setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  }

  async function download(filePath: string): Promise<void> {
    if (!selectedHf) return;
    setWorking(true);
    setHint(null);
    const off = api.onDownloadProgress(setProgress);
    try {
      await api.downloadHfFile(selectedHf, filePath);
      props.setModels(await api.scanModels());
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

  return (
    <div className="stack-page">
      <header className="page-header">
        <div className="row" style={{ justifyContent: "space-between", width: "100%" }}>
          <div>
            <h1 className="h1">Модели</h1>
            <p className="muted page-sub">
              Найдите GGUF на диске или скачайте с Hugging Face, затем загрузите в память
            </p>
          </div>
          <button className="btn" type="button" disabled={working} onClick={() => void scan()}>
            Обновить список
          </button>
        </div>
      </header>

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
            ★ / ngl — рекомендация под VRAM. Красный статус — битый GGUF.
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
                      {loaded ? <span className="badge">в памяти</span> : null}
                    </span>
                  </div>
                  <div className="muted mono" style={{ fontSize: "0.8rem", marginTop: 4 }}>
                    {fmtGb(m.sizeBytes)} · {m.quant || "квант ?"} · слои GPU {m.recommendedNgl}
                    {m.mmprojPath ? " · есть vision (mmproj)" : ""}
                    {m.fitsInVram === false ? " · может не влезть в VRAM" : ""}
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
              <div className="muted">Модели не найдены. Добавьте папку в Настройках или скачайте справа.</div>
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
              placeholder="Поиск, например LFM3 GGUF"
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

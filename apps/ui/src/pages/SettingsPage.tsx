import { useEffect, useRef, useState } from "react";
import type { AppSettings } from "@kovi/shared";
import { api } from "../api";
import { paramLabel } from "../lib/labels";

export function SettingsPage(props: {
  settings: AppSettings | null;
  setSettings: (s: AppSettings) => void;
  setError: (e: string | null) => void;
}) {
  const [draft, setDraft] = useState<AppSettings | null>(props.settings);
  const [saving, setSaving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setDraft(props.settings);
  }, [props.settings]);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  if (!draft) return <div className="stack-page">Загрузка…</div>;

  function queueSave(next: AppSettings): void {
    setDraft(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setSaving(true);
      void api
        .saveSettings(next)
        .then((saved) => props.setSettings(saved))
        .catch((e) => props.setError(e instanceof Error ? e.message : String(e)))
        .finally(() => setSaving(false));
    }, 400);
  }

  async function saveNow(next: AppSettings): Promise<void> {
    if (timer.current) clearTimeout(timer.current);
    setDraft(next);
    setSaving(true);
    try {
      const saved = await api.saveSettings(next);
      props.setSettings(saved);
    } catch (e) {
      props.setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const s = draft;

  return (
    <div className="stack-page">
      <header className="page-header">
        <div className="row" style={{ justifyContent: "space-between", width: "100%" }}>
          <div>
            <h1 className="h1">Настройки</h1>
            <p className="muted page-sub">Тема, доступ агента, папки моделей и параметры по умолчанию</p>
          </div>
          <span className="muted" style={{ fontSize: "0.78rem" }}>
            {saving ? "Сохранение…" : "Сохраняется автоматически"}
          </span>
        </div>
      </header>

      <section className="card elevated">
        <h3>Тема</h3>
        <div className="row" style={{ marginTop: 10 }}>
          {(
            [
              ["dark", "Тёмная"],
              ["light", "Светлая"],
              ["high-contrast", "Контраст"],
              ["custom", "Своя"],
            ] as const
          ).map(([p, label]) => (
            <button
              key={p}
              type="button"
              className={`btn ${s.themePreset === p ? "primary" : ""}`}
              onClick={() => void saveNow({ ...s, themePreset: p })}
            >
              {label}
            </button>
          ))}
        </div>
        {s.themePreset === "custom" && (
          <div className="grid-2" style={{ marginTop: 12 }}>
            <label>
              Акцент
              <input
                className="input"
                type="color"
                value={s.themeCustom.accent}
                onChange={(e) =>
                  queueSave({ ...s, themeCustom: { ...s.themeCustom, accent: e.target.value } })
                }
              />
            </label>
            <label>
              Фон
              <input
                className="input"
                type="color"
                value={s.themeCustom.background}
                onChange={(e) =>
                  queueSave({
                    ...s,
                    themeCustom: { ...s.themeCustom, background: e.target.value },
                  })
                }
              />
            </label>
          </div>
        )}
      </section>

      <section className="card">
        <h3>Доступ к файлам для агента</h3>
        <div className="row" style={{ marginTop: 10 }}>
          <button
            type="button"
            className={`btn ${s.fileAccessMode === "project" ? "primary" : ""}`}
            onClick={() => void saveNow({ ...s, fileAccessMode: "project" })}
          >
            Только папка проекта
          </button>
          <button
            type="button"
            className={`btn ${s.fileAccessMode === "disk" ? "primary" : ""}`}
            onClick={() => void saveNow({ ...s, fileAccessMode: "disk" })}
          >
            Доступ к диску
          </button>
          <button
            type="button"
            className="btn"
            onClick={async () => {
              const dir = await api.pickDirectory();
              if (dir) await saveNow({ ...s, projectRoot: dir });
            }}
          >
            Выбрать папку проекта
          </button>
        </div>
        <div className="muted mono" style={{ marginTop: 10 }}>
          проект: {s.projectRoot || "не задан"}
        </div>
      </section>

      <section className="card">
        <h3>Модели и runtime</h3>
        <div className="row" style={{ marginTop: 10 }}>
          <button
            type="button"
            className="btn"
            onClick={async () => {
              const dir = await api.pickDirectory();
              if (dir) await saveNow({ ...s, modelRoots: [...new Set([...s.modelRoots, dir])] });
            }}
          >
            Добавить папку моделей
          </button>
        </div>
        <div className="muted mono" style={{ marginTop: 10 }}>
          {s.modelRoots.join(" | ") || "папки не заданы"}
        </div>
        <div className="section-block">
          <label className="row">
            <input
              type="checkbox"
              checked={s.autoUpdateRuntime !== false}
              onChange={(e) => void saveNow({ ...s, autoUpdateRuntime: e.target.checked })}
            />
            Автообновление llama.cpp (тихо, не чаще раза в 24 часа)
          </label>
          <label style={{ display: "block", marginTop: 12 }}>
            GitHub Token (необязательно — снимает лимит API)
            <input
              className="input"
              type="password"
              autoComplete="off"
              placeholder="ghp_..."
              value={s.githubToken || ""}
              onChange={(e) => queueSave({ ...s, githubToken: e.target.value })}
            />
          </label>
          <div className="row" style={{ marginTop: 12 }}>
            <label className="row">
              <input
                type="checkbox"
                checked={s.openaiProxyEnabled}
                onChange={(e) => void saveNow({ ...s, openaiProxyEnabled: e.target.checked })}
              />
              Прокси OpenAI-совместимый
            </label>
            <input
              className="input"
              style={{ width: 100 }}
              type="number"
              value={s.openaiProxyPort}
              onChange={(e) => queueSave({ ...s, openaiProxyPort: Number(e.target.value) })}
            />
          </div>
        </div>
      </section>

      <section className="card">
        <h3>Веб-поиск</h3>
        <div className="row" style={{ marginTop: 10 }}>
          <select
            className="select"
            style={{ width: 200 }}
            value={s.webSearchProvider}
            onChange={(e) =>
              void saveNow({
                ...s,
                webSearchProvider: e.target.value as AppSettings["webSearchProvider"],
              })
            }
          >
            <option value="duckduckgo">DuckDuckGo</option>
            <option value="searxng">SearXNG</option>
          </select>
          <input
            className="input"
            placeholder="URL SearXNG (если выбран)"
            value={s.searxngUrl || ""}
            onChange={(e) => queueSave({ ...s, searxngUrl: e.target.value })}
          />
        </div>
      </section>

      <section className="card">
        <h3>Параметры генерации по умолчанию</h3>
        <p className="muted" style={{ margin: "6px 0 0", fontSize: "0.82rem" }}>
          Используются для новых диалогов. В чате можно переопределить для сессии.
        </p>
        <div className="grid-2" style={{ marginTop: 10 }}>
          {(
            [
              ["temperature", s.defaultParams.temperature],
              ["topP", s.defaultParams.topP],
              ["topK", s.defaultParams.topK],
              ["maxTokens", s.defaultParams.maxTokens],
              ["context", s.defaultParams.context],
              ["gpuLayers", s.defaultParams.gpuLayers],
            ] as const
          ).map(([key, value]) => (
            <label key={key}>
              {paramLabel(key)}
              <input
                className="input"
                type="number"
                step="any"
                value={value}
                onChange={(e) =>
                  queueSave({
                    ...s,
                    defaultParams: {
                      ...s.defaultParams,
                      [key]: Number(e.target.value),
                    },
                  })
                }
              />
            </label>
          ))}
        </div>
      </section>
    </div>
  );
}

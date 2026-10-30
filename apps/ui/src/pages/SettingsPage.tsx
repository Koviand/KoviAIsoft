import { useEffect, useRef, useState } from "react";
import type { AppSettings, HardwareLoadSuggestion } from "@kovi/shared";
import { AUTO_PC_PROFILE_ID, THEME_PRESET_OPTIONS } from "@kovi/shared";
import { api } from "../api";
import { paramLabel } from "../lib/labels";

export function SettingsPage(props: {
  settings: AppSettings | null;
  setSettings: (s: AppSettings) => void;
  setError: (e: string | null) => void;
}) {
  const [draft, setDraft] = useState<AppSettings | null>(props.settings);
  const [saving, setSaving] = useState(false);
  const [hwPreview, setHwPreview] = useState<HardwareLoadSuggestion | null>(null);
  const [hwBusy, setHwBusy] = useState(false);
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
        <p className="muted" style={{ margin: "6px 0 0", fontSize: "0.82rem" }}>
          Готовые палитры и своя тема с ручным акцентом/фоном.
        </p>
        <div className="row" style={{ marginTop: 10, flexWrap: "wrap", gap: 8 }}>
          {THEME_PRESET_OPTIONS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              className={`btn ${s.themePreset === id ? "primary" : ""}`}
              onClick={() => void saveNow({ ...s, themePreset: id })}
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
        <h3>Режим подтверждений агента</h3>
        <p className="muted" style={{ margin: "6px 0 0", fontSize: "0.82rem" }}>
          Ask — спрашивать medium/high; Auto-safe — тихо в папке проекта; Full — почти без диалогов.
        </p>
        <div className="row" style={{ marginTop: 10 }}>
          {(
            [
              ["ask", "Ask"],
              ["auto-safe", "Auto-safe"],
              ["full", "Full"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`btn ${(s.agentRiskMode || "ask") === id ? "primary" : ""}`}
              onClick={() => void saveNow({ ...s, agentRiskMode: id })}
            >
              {label}
            </button>
          ))}
        </div>
        <label style={{ display: "block", marginTop: 12 }}>
          Лимит шагов агента
          <input
            className="input"
            type="number"
            value={s.agentMaxSteps}
            onChange={(e) => queueSave({ ...s, agentMaxSteps: Number(e.target.value) || 40 })}
          />
        </label>
      </section>

      <section className="card">
        <h3>Скачивание с Hugging Face</h3>
        <p className="muted" style={{ margin: "6px 0 0", fontSize: "0.82rem" }}>
          Скачивание через встроенный Hugging Face CLI (Python + huggingface_hub в{" "}
          <span className="mono">tools/hf</span>). Если CLI недоступен — HTTP.
        </p>
        <label style={{ display: "block", marginTop: 12 }}>
          Папка для загрузки моделей
          <div className="row" style={{ marginTop: 6 }}>
            <input
              className="input mono"
              style={{ flex: 1 }}
              value={s.downloadDir}
              onChange={(e) => queueSave({ ...s, downloadDir: e.target.value })}
              placeholder="C:\\Models\\GGUF"
            />
            <button
              type="button"
              className="btn"
              disabled={saving}
              onClick={async () => {
                const dir = await api.pickDirectory();
                if (dir) await saveNow({ ...s, downloadDir: dir });
              }}
            >
              Выбрать…
            </button>
          </div>
        </label>
        <div className="row" style={{ marginTop: 10 }}>
          <button
            type="button"
            className="btn"
            disabled={saving}
            onClick={() => {
              setSaving(true);
              void api
                .ensureHfCli()
                .then((st) => {
                  props.setError(
                    st.available
                      ? null
                      : st.hint || "HF CLI не установился",
                  );
                  if (st.available) {
                    // brief success via hint in Models; clear error
                  }
                })
                .catch((e) => props.setError(e instanceof Error ? e.message : String(e)))
                .finally(() => setSaving(false));
            }}
          >
            Установить / проверить встроенный HF CLI
          </button>
        </div>
        <div className="row" style={{ marginTop: 10, flexWrap: "wrap" }}>
          {(
            [
              ["auto", "Авто (CLI → HTTP)"],
              ["cli", "Только HF CLI"],
              ["http", "Только HTTP"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`btn ${(s.hfDownloadMethod || "auto") === id ? "primary" : ""}`}
              onClick={() => void saveNow({ ...s, hfDownloadMethod: id })}
            >
              {label}
            </button>
          ))}
        </div>
        <label style={{ display: "block", marginTop: 12 }}>
          HF Token (опционально, для gated-моделей)
          <input
            className="input"
            type="password"
            autoComplete="off"
            placeholder="hf_…"
            value={s.hfToken || ""}
            onChange={(e) => queueSave({ ...s, hfToken: e.target.value })}
          />
        </label>
      </section>

      <section className="card">
        <h3>Профили загрузки модели</h3>
        <p className="muted" style={{ margin: "6px 0 0", fontSize: "0.82rem" }}>
          GPU layers / context / flash-attn при «Загрузить в память». Кнопка ниже также предложит
          параметры чата (ctx, maxTokens) и лимит шагов агента под VRAM/RAM — без автоприменения.
        </p>
        <div className="row" style={{ marginTop: 10, flexWrap: "wrap" }}>
          {(s.loadProfiles || []).map((p) => (
            <button
              key={p.id}
              type="button"
              className={`btn ${s.activeLoadProfileId === p.id ? "primary" : ""}`}
              onClick={() => void saveNow({ ...s, activeLoadProfileId: p.id })}
            >
              {p.name}
            </button>
          ))}
          <button
            type="button"
            className="btn"
            disabled={hwBusy || saving}
            onClick={() => {
              setHwBusy(true);
              void api
                .suggestHardwareLoadSettings()
                .then(setHwPreview)
                .catch((e) => props.setError(e instanceof Error ? e.message : String(e)))
                .finally(() => setHwBusy(false));
            }}
          >
            Подобрать под мой ПК
          </button>
        </div>
        {(() => {
          const active = (s.loadProfiles || []).find((p) => p.id === s.activeLoadProfileId);
          if (!active) return null;
          return (
            <div className="muted mono" style={{ marginTop: 10, fontSize: "0.8rem" }}>
              ngl {active.gpuLayers} · ctx {active.context}
              {active.flashAttn ? " · flash-attn" : ""}
              {active.maxTokens != null ? ` · maxTokens ${active.maxTokens}` : ""}
              {active.id === AUTO_PC_PROFILE_ID ? " · hardware-aware" : ""}
            </div>
          );
        })()}
        {hwPreview && (
          <div className="card" style={{ marginTop: 12 }} role="dialog" aria-label="Превью под ПК">
            <strong>Превью: {hwPreview.profile.name}</strong>
            <div className="mono" style={{ fontSize: "0.85rem", marginTop: 8 }}>
              загрузка: ngl {hwPreview.profile.gpuLayers} · ctx {hwPreview.profile.context} ·
              maxTokens {hwPreview.profile.maxTokens ?? "—"}
              {hwPreview.profile.flashAttn ? " · flash-attn" : ""} · backend {hwPreview.backend}
            </div>
            <div className="mono" style={{ fontSize: "0.85rem", marginTop: 6 }}>
              чат по умолчанию: ctx {hwPreview.defaultParams.context} · maxTokens{" "}
              {hwPreview.defaultParams.maxTokens} · ngl {hwPreview.defaultParams.gpuLayers}
              {hwPreview.defaultParams.flashAttn ? " · flash" : ""} · агент{" "}
              {hwPreview.agentMaxSteps} шагов
            </div>
            <p style={{ margin: "8px 0 0", fontSize: "0.82rem" }}>{hwPreview.rationale}</p>
            <div className="row" style={{ marginTop: 12, flexWrap: "wrap", gap: 8 }}>
              <button
                className="btn primary"
                type="button"
                disabled={hwBusy}
                onClick={() => {
                  setHwBusy(true);
                  void api
                    .applyHardwareLoadSettings({
                      applyBackend: true,
                      applyDefaultParams: true,
                    })
                    .then((saved) => {
                      props.setSettings(saved);
                      setDraft(saved);
                      setHwPreview(null);
                    })
                    .catch((e) => props.setError(e instanceof Error ? e.message : String(e)))
                    .finally(() => setHwBusy(false));
                }}
              >
                Применить всё
              </button>
              <button
                className="btn"
                type="button"
                disabled={hwBusy}
                onClick={() => {
                  setHwBusy(true);
                  void api
                    .applyHardwareLoadSettings({
                      applyBackend: true,
                      applyDefaultParams: false,
                    })
                    .then((saved) => {
                      props.setSettings(saved);
                      setDraft(saved);
                      setHwPreview(null);
                    })
                    .catch((e) => props.setError(e instanceof Error ? e.message : String(e)))
                    .finally(() => setHwBusy(false));
                }}
              >
                Только профиль загрузки
              </button>
              <button
                className="btn ghost"
                type="button"
                disabled={hwBusy}
                onClick={() => setHwPreview(null)}
              >
                Отмена
              </button>
            </div>
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
        <p className="muted" style={{ marginTop: 8, fontSize: "0.82rem" }}>
          Файл <code>AGENTS.md</code> в корне проекта подхватывается агентом автоматически.
        </p>
      </section>

      <section className="card">
        <h3>Модели и runtime</h3>
        <p className="muted" style={{ margin: "6px 0 0", fontSize: "0.82rem" }}>
          Папки сканирования GGUF и отдельная папка, куда сохраняются новые загрузки с HF.
        </p>
        <div className="row" style={{ marginTop: 10, flexWrap: "wrap" }}>
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
          <button
            type="button"
            className="btn"
            onClick={async () => {
              const dir = await api.pickDirectory();
              if (dir) await saveNow({ ...s, downloadDir: dir });
            }}
          >
            Папка загрузки…
          </button>
        </div>
        <div className="muted mono" style={{ marginTop: 10 }}>
          загрузка: {s.downloadDir || "не задана"}
        </div>
        <div className="muted mono" style={{ marginTop: 6 }}>
          сканирование: {s.modelRoots.join(" | ") || "папки не заданы"}
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
          Используются для новых диалогов. В чате можно переопределить для сессии. Значения
          context / maxTokens / ngl можно подобрать кнопкой «Подобрать под мой ПК» выше.
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
          <label className="row" style={{ alignItems: "center", marginTop: 8 }}>
            <input
              type="checkbox"
              checked={Boolean(s.defaultParams.flashAttn)}
              onChange={(e) =>
                queueSave({
                  ...s,
                  defaultParams: { ...s.defaultParams, flashAttn: e.target.checked },
                })
              }
            />
            Flash Attention по умолчанию
          </label>
        </div>
      </section>
    </div>
  );
}

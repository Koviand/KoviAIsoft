import { useEffect, useRef, useState } from "react";
import type { AppSettings, HardwareLoadSuggestion, LocalModel } from "@kovi/shared";
import { AUTO_PC_PROFILE_ID, THEME_PRESET_OPTIONS } from "@kovi/shared";
import { api } from "../api";
import { PageShell, SettingsSection } from "../components/PageShell";
import { paramLabel } from "../lib/labels";
import { ModelAdvancedSettings } from "../components/ModelAdvancedSettings";

const TIER_IDS = ["fast", "balanced", "quality"] as const;

/** Never put safeStorage placeholder into editable draft fields. */
function sanitizeSettingsDraft(s: AppSettings): AppSettings {
  const scrub = (v: string | undefined) => (v === "__secure__" ? "" : v || "");
  return {
    ...s,
    githubToken: scrub(s.githubToken),
    hfToken: scrub(s.hfToken),
    webSearchApiKey: scrub(s.webSearchApiKey),
  };
}

const SETTINGS_NAV = [
  { id: "appearance", label: "Внешний вид", group: "Интерфейс" },
  { id: "agent-safety", label: "Безопасность", group: "Агент" },
  { id: "project", label: "Проект", group: "Агент" },
  { id: "web-search", label: "Веб-поиск", group: "Агент" },
  { id: "load", label: "Нагрузка ПК", group: "Модели" },
  { id: "hf-download", label: "Hugging Face", group: "Модели" },
  { id: "model-folders", label: "Папки GGUF", group: "Модели" },
  { id: "defaults", label: "Ответ по умолчанию", group: "Модели" },
] as const;

export function SettingsPage(props: {
  settings: AppSettings | null;
  setSettings: (s: AppSettings) => void;
  setError: (e: string | null) => void;
  models?: LocalModel[];
  loadedModelId?: string | null;
  activeSessionId?: string | null;
}) {
  const [draft, setDraft] = useState<AppSettings | null>(props.settings);
  const [saving, setSaving] = useState(false);
  const [hwPreview, setHwPreview] = useState<HardwareLoadSuggestion | null>(null);
  const [hwBusy, setHwBusy] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [models, setModels] = useState<LocalModel[]>(props.models || []);
  const [loadedModelId, setLoadedModelId] = useState<string | null>(
    props.loadedModelId ?? null,
  );
  const [profileHint, setProfileHint] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(false);
  const saveSeq = useRef(0);
  const draftRef = useRef<AppSettings | null>(props.settings);
  draftRef.current = draft;

  useEffect(() => {
    if (props.models) setModels(props.models);
  }, [props.models]);

  useEffect(() => {
    if (props.loadedModelId !== undefined) setLoadedModelId(props.loadedModelId);
  }, [props.loadedModelId]);

  useEffect(() => {
    if (props.models && props.loadedModelId !== undefined) return;
    void api.listModels().then(setModels).catch(() => undefined);
    void api
      .getRuntimeStatus()
      .then((r) => setLoadedModelId(r.loadedModelId))
      .catch(() => undefined);
  }, [props.models, props.loadedModelId]);

  /** Only currently loaded model — do not use models[0] (skews «Под этот ПК»). */
  function preferModelId(): string | undefined {
    return loadedModelId || undefined;
  }

  useEffect(() => {
    if (!dirty.current && props.settings) {
      setDraft(sanitizeSettingsDraft(props.settings));
    }
  }, [props.settings]);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
      // Flush pending local edits so navigating away does not drop them.
      if (dirty.current && draftRef.current) {
        void api.saveSettings(draftRef.current).catch(() => undefined);
      }
    };
  }, []);

  if (!draft) return <div className="stack-page">Загрузка…</div>;

  function cancelPendingSave(): void {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    // Invalidate in-flight/queued debounce so stale draft cannot overwrite hardware apply.
    saveSeq.current += 1;
    dirty.current = false;
  }

  function reloadHint(
    reload: { status: string; detail?: string },
    whenIdle: string,
  ): string {
    if (reload.status === "ok") return reload.detail || "Модель перезагружена.";
    if (reload.status === "skipped") return reload.detail || whenIdle;
    if (reload.status === "error") return reload.detail || "Ошибка перезагрузки.";
    return whenIdle;
  }

  function queueSave(next: AppSettings): void {
    dirty.current = true;
    setDraft(next);
    if (timer.current) clearTimeout(timer.current);
    const mySeq = ++saveSeq.current;
    timer.current = setTimeout(() => {
      setSaving(true);
      void api
        .saveSettings(next)
        .then((saved) => {
          if (mySeq !== saveSeq.current) return;
          dirty.current = false;
          props.setSettings(saved);
          setDraft(saved);
        })
        .catch((e) => props.setError(e instanceof Error ? e.message : String(e)))
        .finally(() => {
          if (mySeq === saveSeq.current) setSaving(false);
        });
    }, 400);
  }

  async function saveNow(next: AppSettings): Promise<void> {
    if (timer.current) clearTimeout(timer.current);
    dirty.current = true;
    const mySeq = ++saveSeq.current;
    setDraft(next);
    setSaving(true);
    try {
      const saved = await api.saveSettings(next);
      if (mySeq !== saveSeq.current) return;
      dirty.current = false;
      props.setSettings(saved);
      setDraft(saved);
    } catch (e) {
      props.setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mySeq === saveSeq.current) setSaving(false);
    }
  }

  const s = draft;
  const activeProfile = (s.loadProfiles || []).find((p) => p.id === s.activeLoadProfileId);

  return (
    <PageShell
      title="Настройки"
      subtitle="Интерфейс, агент и модели. Движок и @codebase — на вкладке «Движок»."
      meta={<span>{saving ? "Сохранение…" : "Автосохранение"}</span>}
      nav={[...SETTINGS_NAV]}
    >
      <SettingsSection
        id="appearance"
        title="Внешний вид"
        description="Готовая палитра или своя тема (акцент и фон)."
        elevated
      >
        <label className="field">
          <span className="field-label">Язык интерфейса / UI language</span>
          <select
            className="select"
            value={s.language || "ru"}
            onChange={(e) => {
              const language = e.target.value === "en" ? "en" : "ru";
              void saveNow({ ...s, language });
            }}
          >
            <option value="ru">Русский</option>
            <option value="en">English</option>
          </select>
        </label>
        <div className="choice-grid">
          {THEME_PRESET_OPTIONS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              className={`choice-tile ${s.themePreset === id ? "on" : ""}`}
              onClick={() => void saveNow({ ...s, themePreset: id })}
            >
              <span className="choice-tile-title">{label}</span>
            </button>
          ))}
        </div>
        {s.themePreset === "custom" && (
          <div className="grid-2">
            <label className="field">
              <span className="field-label">Акцент</span>
              <input
                className="input"
                type="color"
                value={s.themeCustom.accent}
                onChange={(e) =>
                  queueSave({ ...s, themeCustom: { ...s.themeCustom, accent: e.target.value } })
                }
              />
            </label>
            <label className="field">
              <span className="field-label">Фон</span>
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
      </SettingsSection>

      <SettingsSection
        id="agent-safety"
        title="Безопасность агента"
        description="Когда спрашивать разрешение перед опасными действиями (файлы, shell, браузер)."
      >
        <div className="choice-grid">
          {(
            [
              [
                "ask",
                "Спрашивать всегда",
                "Среднее и высокое — только с вашего ОК",
              ],
              [
                "auto-safe",
                "В проекте сам",
                "В папке проекта средние без спроса; shell и высокое — спросит",
              ],
              [
                "full",
                "Минимум вопросов",
                "Средние без спроса; shell, браузер и высокое — спросит",
              ],
            ] as const
          ).map(([id, label, tip]) => (
            <button
              key={id}
              type="button"
              title={tip}
              className={`choice-tile ${(s.agentRiskMode || "ask") === id ? "on" : ""}`}
              onClick={() => void saveNow({ ...s, agentRiskMode: id })}
            >
              <span className="choice-tile-title">{label}</span>
              <span className="choice-tile-sub">{tip}</span>
            </button>
          ))}
        </div>
        <label className="field">
          <span className="field-label">Максимум шагов за один запуск (0 = без лимита)</span>
          <input
            className="input"
            type="number"
            value={s.agentMaxSteps}
            onChange={(e) => {
              const n = Number(e.target.value);
              const clamped = !Number.isFinite(n)
                ? 0
                : n <= 0
                  ? 0
                  : Math.min(2000, Math.floor(n));
              queueSave({ ...s, agentMaxSteps: clamped });
            }}
            min={0}
            max={2000}
          />
        </label>
        <label className="field" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="checkbox"
            checked={s.agentAutoExtendEnabled !== false}
            onChange={(e) =>
              void saveNow({ ...s, agentAutoExtendEnabled: e.target.checked })
            }
          />
          <span className="field-label" style={{ margin: 0 }}>
            Автопродолжение при незакрытом плане
          </span>
        </label>
        <label className="field">
          <span className="field-label">
            Таймаут подтверждения (сек; 0 = без авто-отклонения, иначе мин. 5)
          </span>
          <input
            className="input"
            type="number"
            value={s.agentConfirmTimeoutSec ?? 120}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (!Number.isFinite(n)) return;
              const floor = Math.floor(n);
              const clamped =
                floor <= 0 ? 0 : Math.max(5, Math.min(600, floor));
              queueSave({ ...s, agentConfirmTimeoutSec: clamped });
            }}
            min={0}
            max={600}
          />
        </label>
        <div className="grid-2">
          <label className="field">
            <span className="field-label">Макс. автопродолжений</span>
            <input
              className="input"
              type="number"
              value={s.agentAutoExtendMax ?? 10}
              onChange={(e) => {
                const n = Number(e.target.value);
                const clamped = !Number.isFinite(n)
                  ? 10
                  : Math.max(0, Math.min(40, Math.floor(n)));
                queueSave({ ...s, agentAutoExtendMax: clamped });
              }}
              min={0}
              max={40}
            />
          </label>
          <label className="field">
            <span className="field-label">Лимит времени запуска (мин, 0 = выкл)</span>
            <input
              className="input"
              type="number"
              value={s.agentMaxRunMinutes ?? 30}
              onChange={(e) => {
                const n = Number(e.target.value);
                const clamped = !Number.isFinite(n)
                  ? 30
                  : Math.max(0, Math.min(240, Math.floor(n)));
                queueSave({ ...s, agentMaxRunMinutes: clamped });
              }}
              min={0}
              max={240}
            />
          </label>
        </div>
      </SettingsSection>

      <SettingsSection
        id="project"
        title="Проект и доступ к файлам"
        description={
          <>
            Корень проекта для агента и <code>@codebase</code>. Модель поиска — на вкладке «Движок».
          </>
        }
      >
        <div className="choice-grid">
          <button
            type="button"
            className={`choice-tile ${s.fileAccessMode === "project" ? "on" : ""}`}
            onClick={() => void saveNow({ ...s, fileAccessMode: "project" })}
          >
            <span className="choice-tile-title">Только папка проекта</span>
            <span className="choice-tile-sub">Агент не выходит за выбранный корень</span>
          </button>
          <button
            type="button"
            className={`choice-tile ${s.fileAccessMode === "disk" ? "on" : ""}`}
            onClick={() => void saveNow({ ...s, fileAccessMode: "disk" })}
          >
            <span className="choice-tile-title">Весь диск</span>
            <span className="choice-tile-sub">Шире доступ — используйте осторожно</span>
          </button>
        </div>
        <div className="field">
          <span className="field-label">Папка проекта</span>
          <div className="field-row">
            <span className="path-chip">{s.projectRoot || "не задана"}</span>
            <button
              type="button"
              className="btn"
              onClick={async () => {
                const dir = await api.pickDirectory();
                if (dir) await saveNow({ ...s, projectRoot: dir });
              }}
            >
              Выбрать…
            </button>
          </div>
          <p className="field-hint">
            <code>AGENTS.md</code> в корне подхватывается автоматически. Индекс:{" "}
            <code>.kovi/codebase-index/</code>
          </p>
        </div>
      </SettingsSection>

      <SettingsSection
        id="web-search"
        title="Интернет для модели"
        description="Поиск, браузер агента и актуальные факты в чате (погода, новости, курсы)."
      >
        <label className="field">
          <span className="field-label">Доступ в интернет</span>
          <select
            className="select"
            value={s.internetAccessMode || "ask"}
            onChange={(e) =>
              void saveNow({
                ...s,
                internetAccessMode: e.target.value as AppSettings["internetAccessMode"],
              })
            }
          >
            <option value="off">Выкл — модель не ходит в сеть</option>
            <option value="ask">Спрашивать — подтверждать каждый web_search</option>
            <option value="allow">Разрешить — поиск без лишних вопросов</option>
          </select>
          <p className="muted" style={{ marginTop: 6, fontSize: 13 }}>
            В режиме «Спрашивать» агент запросит подтверждение перед поиском (можно «запомнить на
            сессию»). Открытие страниц в браузере (navigate/click) всегда требует подтверждения.
            В чате запрос вроде «какая погода» сам по себе даёт согласие на этот ответ.
          </p>
        </label>
        <div className="grid-2">
          <label className="field">
            <span className="field-label">Провайдер поиска</span>
            <select
              className="select"
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
              <option value="tavily">Tavily</option>
            </select>
          </label>
          <label className="field">
            <span className="field-label">URL SearXNG</span>
            <input
              className="input"
              placeholder="если выбран SearXNG"
              value={s.searxngUrl || ""}
              onChange={(e) => queueSave({ ...s, searxngUrl: e.target.value })}
            />
          </label>
        </div>
        <label className="field">
          <span className="field-label">Tavily API key</span>
          <input
            className="input"
            type="password"
            autoComplete="off"
            placeholder="tvly-… (для провайдера Tavily)"
            value={s.webSearchApiKey || ""}
            onChange={(e) => queueSave({ ...s, webSearchApiKey: e.target.value })}
          />
        </label>
      </SettingsSection>

      <SettingsSection
        id="load"
        title="Нагрузка на ПК"
        description="Быстро — легче по VRAM, Качество — тяжелее. После смены перезагрузите модель."
      >
        <div className="choice-grid">
          {TIER_IDS.map((id) => {
            const p = (s.loadProfiles || []).find((x) => x.id === id);
            const label =
              id === "fast" ? "Быстро" : id === "quality" ? "Качество" : "Баланс";
            return (
              <button
                key={id}
                type="button"
                className={`choice-tile ${s.activeLoadProfileId === id ? "on" : ""}`}
                disabled={hwBusy || saving}
                title={p ? `ngl ${p.gpuLayers} · ctx ${p.context}` : undefined}
                onClick={() => {
                  cancelPendingSave();
                  setHwBusy(true);
                  void api
                    .applyLoadProfileToSettings({
                      profileId: id,
                      modelId: preferModelId(),
                    })
                    .then((res) => {
                      props.setSettings(res.settings);
                      setDraft(sanitizeSettingsDraft(res.settings));
                      dirty.current = false;
                      setProfileHint(
                        reloadHint(res.reload, `Активен уровень «${label}»`),
                      );
                      void api.getRuntimeStatus().then((r) => setLoadedModelId(r.loadedModelId));
                    })
                    .catch((e) => props.setError(e instanceof Error ? e.message : String(e)))
                    .finally(() => setHwBusy(false));
                }}
              >
                <span className="choice-tile-title">{label}</span>
                {p && (
                  <span className="choice-tile-sub">
                    ngl {p.gpuLayers} · ctx {p.context}
                    {p.hardwareAware ? " · при загрузке" : ""}
                  </span>
                )}
              </button>
            );
          })}
          <button
            type="button"
            className={`choice-tile ${s.activeLoadProfileId === AUTO_PC_PROFILE_ID ? "on" : ""}`}
            disabled={hwBusy || saving}
            onClick={() => {
              cancelPendingSave();
              setHwBusy(true);
              void api
                .applyHardwareLoadSettings({
                  modelId: preferModelId(),
                  applyBackend: true,
                  applyDefaultParams: true,
                })
                .then((res) => {
                  props.setSettings(res.settings);
                  setDraft(sanitizeSettingsDraft(res.settings));
                  dirty.current = false;
                  setHwPreview(null);
                  setProfileHint(
                    reloadHint(
                      res.reload,
                      preferModelId()
                        ? "Настройки под этот ПК применены (backend=auto)"
                        : "Под ПК применено без размера модели — загрузите модель для точного ngl",
                    ),
                  );
                  void api.getRuntimeStatus().then((r) => setLoadedModelId(r.loadedModelId));
                })
                .catch((e) => props.setError(e instanceof Error ? e.message : String(e)))
                .finally(() => setHwBusy(false));
            }}
          >
            <span className="choice-tile-title">Под этот ПК</span>
            <span className="choice-tile-sub">Автоподбор · backend auto</span>
          </button>
        </div>

        {(s.loadProfiles || []).some(
          (p) =>
            !TIER_IDS.includes(p.id as (typeof TIER_IDS)[number]) &&
            p.id !== AUTO_PC_PROFILE_ID,
        ) && (
          <div className="toolbar-row">
            {(s.loadProfiles || [])
              .filter(
                (p) =>
                  !TIER_IDS.includes(p.id as (typeof TIER_IDS)[number]) &&
                  p.id !== AUTO_PC_PROFILE_ID,
              )
              .map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`btn ghost ${s.activeLoadProfileId === p.id ? "primary" : ""}`}
                  disabled={hwBusy || saving}
                  onClick={() => {
                    cancelPendingSave();
                    setHwBusy(true);
                    void api
                      .applyLoadProfileToSettings({
                        profileId: p.id,
                        modelId: preferModelId(),
                      })
                      .then((res) => {
                        props.setSettings(res.settings);
                        setDraft(sanitizeSettingsDraft(res.settings));
                        dirty.current = false;
                        setProfileHint(
                          reloadHint(res.reload, `Активен профиль «${p.name}»`),
                        );
                        void api.getRuntimeStatus().then((r) => setLoadedModelId(r.loadedModelId));
                      })
                      .catch((e) => props.setError(e instanceof Error ? e.message : String(e)))
                      .finally(() => setHwBusy(false));
                  }}
                >
                  {p.name}
                </button>
              ))}
          </div>
        )}

        <div className="toolbar-row">
          <button
            type="button"
            className="btn"
            disabled={hwBusy || saving}
            onClick={() => {
              setHwBusy(true);
              void api
                .suggestHardwareLoadSettings({ modelId: preferModelId() })
                .then(setHwPreview)
                .catch((e) => props.setError(e instanceof Error ? e.message : String(e)))
                .finally(() => setHwBusy(false));
            }}
          >
            Превью под ПК
          </button>
          <button
            type="button"
            className="btn ghost"
            disabled={saving}
            onClick={() => setAdvancedOpen(true)}
          >
            Параметры…
          </button>
        </div>

        {profileHint && (
          <div className="muted" style={{ fontSize: "0.82rem" }} role="status">
            {profileHint}
          </div>
        )}

        {activeProfile && (
          <dl className="kv-list">
            <dt>ngl</dt>
            <dd>
              {activeProfile.gpuLayers}
              {activeProfile.hardwareAware ? " (пересчёт при загрузке)" : ""}
            </dd>
            <dt>ctx</dt>
            <dd>
              {activeProfile.context}
              {activeProfile.hardwareAware ? " (пересчёт при загрузке)" : ""}
            </dd>
            {activeProfile.maxTokens != null && (
              <>
                <dt>maxTokens</dt>
                <dd>{activeProfile.maxTokens}</dd>
              </>
            )}
            <dt>флаги</dt>
            <dd>
              {[
                activeProfile.flashAttn ? "flash-attn" : null,
                activeProfile.hardwareAware || activeProfile.id === AUTO_PC_PROFILE_ID
                  ? "hardware-aware"
                  : null,
              ]
                .filter(Boolean)
                .join(" · ") || "—"}
            </dd>
          </dl>
        )}

        {hwPreview && (
          <div className="card" role="dialog" aria-label="Превью под ПК">
            <strong>Превью: {hwPreview.profile.name}</strong>
            <dl className="kv-list" style={{ marginTop: 10 }}>
              <dt>загрузка</dt>
              <dd>
                ngl {hwPreview.profile.gpuLayers} · ctx {hwPreview.profile.context} · maxTokens{" "}
                {hwPreview.profile.maxTokens ?? "—"}
                {hwPreview.profile.flashAttn ? " · flash-attn" : ""} · backend {hwPreview.backend}
              </dd>
              <dt>чат</dt>
              <dd>
                ctx {hwPreview.defaultParams.context} · maxTokens {hwPreview.defaultParams.maxTokens}{" "}
                · ngl {hwPreview.defaultParams.gpuLayers}
                {hwPreview.defaultParams.flashAttn ? " · flash" : ""} · агент{" "}
                {hwPreview.agentMaxSteps <= 0
                  ? "без лимита"
                  : `${hwPreview.agentMaxSteps} шагов`}
              </dd>
            </dl>
            <p style={{ margin: "8px 0 0", fontSize: "0.82rem" }}>{hwPreview.rationale}</p>
            <div className="toolbar-row" style={{ marginTop: 12 }}>
              <button
                className="btn primary"
                type="button"
                disabled={hwBusy}
                onClick={() => {
                  cancelPendingSave();
                  setHwBusy(true);
                  void api
                    .applyHardwareLoadSettings({
                      modelId: preferModelId(),
                      applyBackend: true,
                      applyDefaultParams: true,
                    })
                    .then((res) => {
                      props.setSettings(res.settings);
                      setDraft(sanitizeSettingsDraft(res.settings));
                      dirty.current = false;
                      setHwPreview(null);
                      setProfileHint(reloadHint(res.reload, "Применено всё под ПК"));
                      void api.getRuntimeStatus().then((r) => setLoadedModelId(r.loadedModelId));
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
                  cancelPendingSave();
                  setHwBusy(true);
                  void api
                    .applyHardwareLoadSettings({
                      modelId: preferModelId(),
                      applyBackend: true,
                      applyDefaultParams: false,
                    })
                    .then((res) => {
                      props.setSettings(res.settings);
                      setDraft(sanitizeSettingsDraft(res.settings));
                      dirty.current = false;
                      setHwPreview(null);
                      setProfileHint(
                        reloadHint(res.reload, "Профиль загрузки обновлён (backend=auto)"),
                      );
                      void api.getRuntimeStatus().then((r) => setLoadedModelId(r.loadedModelId));
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
      </SettingsSection>

      <SettingsSection
        id="hf-download"
        title="Скачивание с Hugging Face"
        description="Куда сохранять GGUF и как качать: встроенный HF CLI или HTTP."
      >
        <label className="field">
          <span className="field-label">Папка для новых загрузок</span>
          <div className="field-row">
            <input
              className="input mono"
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
        <div className="toolbar-row">
          <button
            type="button"
            className="btn"
            disabled={saving}
            onClick={() => {
              setSaving(true);
              void api
                .ensureHfCli()
                .then((st) => {
                  props.setError(st.available ? null : st.hint || "HF CLI не установился");
                })
                .catch((e) => props.setError(e instanceof Error ? e.message : String(e)))
                .finally(() => setSaving(false));
            }}
          >
            Проверить / установить HF CLI
          </button>
        </div>
        <div className="choice-grid">
          {(
            [
              ["auto", "Авто", "CLI, иначе HTTP"],
              ["cli", "Только CLI", "Hugging Face CLI"],
              ["http", "Только HTTP", "Без CLI"],
            ] as const
          ).map(([id, label, tip]) => (
            <button
              key={id}
              type="button"
              className={`choice-tile ${(s.hfDownloadMethod || "auto") === id ? "on" : ""}`}
              onClick={() => void saveNow({ ...s, hfDownloadMethod: id })}
            >
              <span className="choice-tile-title">{label}</span>
              <span className="choice-tile-sub">{tip}</span>
            </button>
          ))}
        </div>
        <label className="field">
          <span className="field-label">Токен Hugging Face</span>
          <input
            className="input"
            type="password"
            autoComplete="off"
            placeholder="hf_… — для закрытых моделей"
            value={s.hfToken || ""}
            onChange={(e) => queueSave({ ...s, hfToken: e.target.value })}
          />
        </label>
      </SettingsSection>

      <SettingsSection
        id="model-folders"
        title="Папки моделей GGUF"
        description="Откуда приложение находит локальные модели. Папка загрузки — в блоке Hugging Face."
      >
        <div className="toolbar-row">
          <button
            type="button"
            className="btn"
            onClick={async () => {
              const dir = await api.pickDirectory();
              if (dir) await saveNow({ ...s, modelRoots: [...new Set([...s.modelRoots, dir])] });
            }}
          >
            Добавить папку для сканирования
          </button>
        </div>
        <div className="field">
          <span className="field-label">Сканирование</span>
          <span className="path-chip">
            {s.modelRoots.length ? s.modelRoots.join(" · ") : "папки не заданы"}
          </span>
        </div>
        <div className="section-block" style={{ marginTop: 0 }}>
          <label className="field">
            <span className="field-label">OpenAI-прокси</span>
            <div className="field-row">
              <label className="row">
                <input
                  type="checkbox"
                  checked={s.openaiProxyEnabled}
                  onChange={(e) => void saveNow({ ...s, openaiProxyEnabled: e.target.checked })}
                />
                Включить для внешних клиентов
              </label>
              <input
                className="input"
                style={{ width: 110 }}
                type="number"
                title="Порт прокси"
                min={1}
                max={65535}
                value={s.openaiProxyPort}
                onChange={(e) => {
                  const raw = e.target.value.trim();
                  if (!raw) return;
                  const n = Number(raw);
                  if (!Number.isFinite(n)) return;
                  queueSave({
                    ...s,
                    openaiProxyPort: Math.max(1, Math.min(65535, Math.floor(n))),
                  });
                }}
              />
            </div>
          </label>
        </div>
      </SettingsSection>

      <SettingsSection
        id="defaults"
        title="Ответ модели по умолчанию"
        description="Для новых чатов. Context / max tokens / GPU layers удобнее задать в блоке нагрузки."
      >
        <div className="grid-2">
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
            <label key={key} className="field">
              <span className="field-label">{paramLabel(key)}</span>
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
        <label className="row">
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
      </SettingsSection>

      <ModelAdvancedSettings
        open={advancedOpen}
        onClose={() => setAdvancedOpen(false)}
        settings={s}
        setSettings={(saved) => {
          props.setSettings(saved);
          setDraft(saved);
        }}
        models={models}
        loadedModelId={loadedModelId}
        focusModelId={preferModelId() || null}
        activeSessionId={props.activeSessionId}
        setError={props.setError}
        onHint={setProfileHint}
      />
    </PageShell>
  );
}

import { useEffect, useState } from "react";
import type {
  AppSettings,
  HardwareLoadSuggestion,
  HfCliStatus,
  HfFile,
  HfSearchResult,
  LocalModel,
  ModelPerfTier,
  ModelRecommendation,
  ModelRecommendationsReport,
} from "@kovi/shared";
import { AUTO_PC_PROFILE_ID } from "@kovi/shared";
import { api } from "../api";
import { PageShell, SettingsSection } from "../components/PageShell";
import { ModelAdvancedSettings } from "../components/ModelAdvancedSettings";

const MODELS_NAV = [
  { id: "recommend", label: "Рекомендации", group: "Подбор" },
  { id: "load-tier", label: "Нагрузка", group: "Подбор" },
  { id: "local-models", label: "На ПК", group: "Файлы" },
  { id: "hf-download", label: "Hugging Face", group: "Файлы" },
] as const;

const TIER_PROFILE_IDS = ["fast", "balanced", "quality"] as const;

function fmtGb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/** Green = fits well, yellow = slow/ok, red = won't run well. */
function tierGroup(tier: ModelPerfTier): "green" | "yellow" | "red" {
  if (tier === "excellent" || tier === "good") return "green";
  if (tier === "too_heavy") return "red";
  return "yellow";
}

function tierLabel(tier: ModelPerfTier): string {
  switch (tierGroup(tier)) {
    case "green":
      return "Подходит";
    case "yellow":
      return tier === "cpu" ? "Медленно (CPU)" : "Медленно";
    case "red":
      return "Не пойдёт";
  }
}

function tierClass(tier: ModelPerfTier): string {
  return `badge fit-${tierGroup(tier)}`;
}

function localFitGroup(
  m: LocalModel,
): "green" | "yellow" | "red" | null {
  if (m.integrityOk === false) return "red";
  if (m.fitsInVram === true) return "green";
  if (m.fitsInVram === false) {
    // Partial GPU offload still usable; very large vs no GPU hint → red if ngl is 0 and huge.
    if (m.recommendedNgl <= 0 && m.sizeBytes > 12 * 1024 ** 3) return "red";
    return "yellow";
  }
  return null;
}

export function ModelsPage(props: {
  models: LocalModel[];
  loadedModelId: string | null;
  settings: AppSettings | null;
  activeSessionId?: string | null;
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
  const [hwPreview, setHwPreview] = useState<HardwareLoadSuggestion | null>(null);
  const [hwBusy, setHwBusy] = useState(false);
  const [hfCli, setHfCli] = useState<HfCliStatus | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [focusModelId, setFocusModelId] = useState<string | null>(null);

  /** Only loaded or explicitly focused model — never models[0] (wrong size tightens profile). */
  function preferModelId(): string | undefined {
    return props.loadedModelId || focusModelId || undefined;
  }

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
    void api
      .getHfCliStatus()
      .then(setHfCli)
      .catch(() => setHfCli(null));
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
      try {
        const bar = await api.getStatusBar();
        if (bar.busy) {
          throw new Error("Сначала остановите генерацию или агента, затем загрузите модель");
        }
      } catch (e) {
        if (e instanceof Error && /остановите/i.test(e.message)) throw e;
      }
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

  async function removeModel(modelId: string, name: string): Promise<void> {
    const ok = window.confirm(
      `Удалить модель «${name}» с диска?\n\nФайл .gguf будет удалён безвозвратно.`,
    );
    if (!ok) return;
    setWorking(true);
    setHint(null);
    try {
      const next = await api.deleteModel(modelId);
      props.setModels(next);
      await props.refresh();
      setHint(`Модель «${name}» удалена`);
    } catch (e) {
      props.setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  }

  async function setProfile(id: string): Promise<void> {
    if (!props.settings) return;
    try {
      const saved = await api.applyLoadProfileToSettings({
        profileId: id,
        modelId: preferModelId(),
      });
      props.setSettings(saved);
      if (props.loadedModelId) {
        setHint("Профиль применён, модель перезагружена с новыми ngl/ctx.");
        await props.refresh();
      } else {
        setHint(`Профиль «${saved.loadProfiles.find((p) => p.id === id)?.name || id}» активен`);
      }
    } catch (e) {
      props.setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function pickDownloadDir(): Promise<void> {
    if (!props.settings) return;
    try {
      const dir = await api.pickDirectory();
      if (!dir) return;
      const saved = await api.saveSettings({ ...props.settings, downloadDir: dir });
      props.setSettings(saved);
      setHint(`Загрузки будут сохраняться в ${saved.downloadDir}`);
    } catch (e) {
      props.setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function suggestHardware(): Promise<void> {
    setHwBusy(true);
    setHint(null);
    try {
      const mid = preferModelId();
      const preview = await api.suggestHardwareLoadSettings({ modelId: mid });
      setHwPreview(preview);
      if (!mid) {
        setHint("Превью без размера модели — загрузите модель, чтобы учесть её вес в VRAM.");
      }
    } catch (e) {
      props.setError(e instanceof Error ? e.message : String(e));
    } finally {
      setHwBusy(false);
    }
  }

  async function applyHardware(): Promise<void> {
    setHwBusy(true);
    try {
      const mid = preferModelId();
      const saved = await api.applyHardwareLoadSettings({
        modelId: mid,
        applyBackend: true,
        applyDefaultParams: true,
      });
      props.setSettings(saved);
      setHwPreview(null);
      const auto = saved.loadProfiles.find((p) => p.id === AUTO_PC_PROFILE_ID);
      setHint(
        `Под ПК: ngl ${auto?.gpuLayers}, ctx ${saved.defaultParams.context}, maxTokens ${saved.defaultParams.maxTokens}.${
          props.loadedModelId
            ? " Модель перезагружена с этими параметрами."
            : mid
              ? ""
              : " Размер модели не учтён — загрузите модель и нажмите снова."
        }`,
      );
      await props.refresh();
    } catch (e) {
      props.setError(e instanceof Error ? e.message : String(e));
    } finally {
      setHwBusy(false);
    }
  }

  const profiles = props.settings?.loadProfiles || [];
  const activeProfileId = props.settings?.activeLoadProfileId;
  const tierProfiles = TIER_PROFILE_IDS.map(
    (id) => profiles.find((p) => p.id === id) || null,
  ).filter(Boolean) as typeof profiles;
  const otherProfiles = profiles.filter(
    (p) =>
      !TIER_PROFILE_IDS.includes(p.id as (typeof TIER_PROFILE_IDS)[number]) &&
      p.id !== AUTO_PC_PROFILE_ID,
  );
  const autoPc = profiles.find((p) => p.id === AUTO_PC_PROFILE_ID);
  // Show greens/yellows first, keep a few reds so «не пойдёт» видно.
  const topRecs = (recs?.items || []).slice(0, 12);

  return (
    <PageShell
      title="Модели"
      subtitle="Рекомендации под железо, локальные GGUF и загрузка с Hugging Face"
      actions={
        <button className="btn" type="button" disabled={working} onClick={() => void scan()}>
          Обновить список
        </button>
      }
      nav={[...MODELS_NAV]}
    >
      <SettingsSection
        id="recommend"
        title="Что скачать на этот ПК"
        description={
          recsLoading && !recs
            ? "Считаем рекомендации…"
            : recs?.summary || "Нажмите «Пересчитать», чтобы оценить модели под VRAM/RAM."
        }
        elevated
      >
        <div className="toolbar-row">
            <button
              className="btn"
              type="button"
              disabled={hwBusy || working}
              onClick={() => void suggestHardware()}
            >
              Подобрать под мой ПК
            </button>
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
          <div className="status-strip mono">
            {recs.gpuName ? `GPU: ${recs.gpuName}` : "GPU не обнаружен"}
            {recs.vramGb != null ? ` · VRAM ${recs.vramGb.toFixed(1)} GB` : ""}
            {` · RAM ${recs.ramGb.toFixed(0)} GB · backend ${recs.backend}`}
          </div>
        )}
        {hwPreview && (
          <div
            className="card"
            style={{ borderColor: "color-mix(in srgb, var(--accent) 40%, var(--border))" }}
            role="dialog"
            aria-label="Превью настроек под ПК"
          >
            <strong>Предложенные настройки загрузки</strong>
            <dl className="kv-list" style={{ marginTop: 10 }}>
              <dt>железо</dt>
              <dd>
                {hwPreview.gpuName ? `GPU: ${hwPreview.gpuName}` : "GPU не обнаружен"}
                {hwPreview.vramGb != null ? ` · VRAM ${hwPreview.vramGb.toFixed(1)} GB` : ""}
                {` · RAM ${hwPreview.ramGb.toFixed(0)} GB`}
              </dd>
              <dt>загрузка</dt>
              <dd>
                ngl {hwPreview.profile.gpuLayers} · ctx {hwPreview.profile.context} · maxTokens{" "}
                {hwPreview.profile.maxTokens ?? "—"}
                {hwPreview.profile.flashAttn ? " · flash-attn" : ""} · backend {hwPreview.backend}
              </dd>
              <dt>чат</dt>
              <dd>
                ctx {hwPreview.defaultParams.context} · maxTokens {hwPreview.defaultParams.maxTokens}{" "}
                · агент {hwPreview.agentMaxSteps} шагов
              </dd>
            </dl>
            <p style={{ margin: "8px 0 0", fontSize: "0.82rem" }}>{hwPreview.rationale}</p>
            <div className="toolbar-row" style={{ marginTop: 12 }}>
              <button
                className="btn primary"
                type="button"
                disabled={hwBusy}
                onClick={() => void applyHardware()}
              >
                Применить
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
        <div className="toolbar-row">
          <span className="badge fit-green">Подходит</span>
          <span className="badge fit-yellow">Медленно</span>
          <span className="badge fit-red">Не пойдёт</span>
        </div>
        <div className="recommend-grid">
          {topRecs.map((item) => (
            <div key={item.id} className={`recommend-item fit-card-${tierGroup(item.tier)}`}>
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
      </SettingsSection>

      <SettingsSection
        id="load-tier"
        title="Уровень нагрузки"
        description="Быстро / Баланс / Качество — hardware-aware. «Под этот ПК» пересчитывает все уровни."
      >
        <div className="toolbar-row">
          <button
            className="btn"
            type="button"
            disabled={!props.settings || working}
            onClick={() => {
              setFocusModelId(preferModelId() || null);
              setAdvancedOpen(true);
            }}
          >
            Параметры…
          </button>
        </div>
        <div className="choice-grid">
          {(tierProfiles.length
            ? tierProfiles
            : [
                { id: "fast", name: "Быстро", gpuLayers: 99, context: 4096, flashAttn: true },
                { id: "balanced", name: "Баланс", gpuLayers: 99, context: 8192, flashAttn: false },
                { id: "quality", name: "Качество", gpuLayers: 99, context: 16384, flashAttn: true },
              ]
          ).map((p) => (
            <button
              key={p.id}
              type="button"
              className={`choice-tile ${activeProfileId === p.id ? "on" : ""}`}
              disabled={working || hwBusy}
              onClick={() => void setProfile(p.id)}
              title={`ngl ${p.gpuLayers} · ctx ${p.context}${p.flashAttn ? " · flash" : ""}`}
            >
              <span className="choice-tile-title">{p.name}</span>
              <span className="choice-tile-sub">
                ngl {p.gpuLayers} · ctx {p.context}
              </span>
            </button>
          ))}
          <button
            type="button"
            className={`choice-tile ${activeProfileId === AUTO_PC_PROFILE_ID ? "on" : ""}`}
            disabled={working || hwBusy}
            onClick={() => void applyHardware()}
            title={
              autoPc
                ? `ngl ${autoPc.gpuLayers} · ctx ${autoPc.context}`
                : "Пересчитать под железо"
            }
          >
            <span className="choice-tile-title">Под этот ПК</span>
            <span className="choice-tile-sub">
              {autoPc ? `ngl ${autoPc.gpuLayers} · ctx ${autoPc.context}` : "Автоподбор"}
            </span>
          </button>
        </div>
        {otherProfiles.length > 0 && (
          <div className="toolbar-row">
            {otherProfiles.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`btn ghost ${activeProfileId === p.id ? "primary" : ""}`}
                disabled={working || hwBusy}
                onClick={() => void setProfile(p.id)}
                title={`ngl ${p.gpuLayers} · ctx ${p.context}`}
              >
                {p.name}
              </button>
            ))}
          </div>
        )}
      </SettingsSection>

      {hint && (
        <div className="status-strip" role="status">
          {hint}
        </div>
      )}

      <div className="grid-2">
        <SettingsSection
          id="local-models"
          title="На этом компьютере"
          description="Зелёный — влезет в VRAM, жёлтый — offload/медленно, красный — битый или слишком тяжёлый."
          elevated
        >
          <div className="stack" style={{ maxHeight: 420 }}>
            {props.models.map((m) => {
              const loaded = props.loadedModelId === m.id;
              const fit = localFitGroup(m);
              return (
                <div
                  key={m.id}
                  className={`list-item model-row${fit ? ` fit-card-${fit}` : ""}`}
                  style={{ padding: "12px 10px" }}
                >
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <strong>{m.name}</strong>
                    <span className="row">
                      {m.integrityOk === false ? (
                        <span className="badge fit-red">битый GGUF</span>
                      ) : null}
                      {fit === "green" ? (
                        <span className="badge fit-green">Подходит</span>
                      ) : null}
                      {fit === "yellow" ? (
                        <span className="badge fit-yellow">Медленно</span>
                      ) : null}
                      {fit === "red" && m.integrityOk !== false ? (
                        <span className="badge fit-red">Не пойдёт</span>
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
                  <div className="row" style={{ marginTop: 10, flexWrap: "wrap", gap: 8 }}>
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
                      disabled={working || !props.settings}
                      onClick={() => {
                        setFocusModelId(m.id);
                        setAdvancedOpen(true);
                      }}
                    >
                      Параметры…
                    </button>
                    <button
                      className="btn ghost"
                      type="button"
                      disabled={working}
                      onClick={() => void verify(m.id)}
                    >
                      Проверить GGUF
                    </button>
                    <button
                      className="btn ghost"
                      type="button"
                      disabled={working}
                      title="Удалить файл .gguf с диска"
                      onClick={() => void removeModel(m.id, m.name)}
                    >
                      Удалить
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
        </SettingsSection>

        <SettingsSection
          id="hf-download"
          title="Скачать с Hugging Face"
          description={
            hfCli?.installing
              ? "Устанавливается встроенный HF CLI…"
              : hfCli?.available
                ? `${hfCli.bundled ? "Встроенный" : "Системный"} HF CLI${hfCli.version ? ` · ${hfCli.version}` : ""} · режим ${props.settings?.hfDownloadMethod || "auto"}`
                : `Встроенный HF CLI ещё не установлен — поставится при скачивании. Режим: ${props.settings?.hfDownloadMethod || "auto"}`
          }
          elevated
        >
          <div className="row" style={{ marginTop: 10, flexWrap: "wrap", gap: 8 }}>
            <div className="muted mono" style={{ fontSize: "0.78rem", flex: "1 1 200px" }}>
              папка: {props.settings?.downloadDir || "не задана"}
            </div>
            <button
              className="btn"
              type="button"
              disabled={working || !props.settings}
              onClick={() => void pickDownloadDir()}
            >
              Папка загрузки…
            </button>
          </div>
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
            {!hfCli?.available && (
              <button
                className="btn"
                type="button"
                disabled={working || Boolean(hfCli?.installing)}
                onClick={() => {
                  setWorking(true);
                  const off = api.onDownloadProgress(setProgress);
                  void api
                    .ensureHfCli()
                    .then(setHfCli)
                    .catch((e) => props.setError(e instanceof Error ? e.message : String(e)))
                    .finally(() => {
                      off();
                      setProgress(null);
                      setWorking(false);
                    });
                }}
              >
                Установить HF CLI
              </button>
            )}
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
            {hf.map((r) => {
              const fit = r.tier ? tierGroup(r.tier) : null;
              return (
                <button
                  key={r.id}
                  type="button"
                  className={`list-item${fit ? ` fit-card-${fit}` : ""}${selectedHf === r.id ? " active" : ""}`}
                  style={{ padding: "10px" }}
                  disabled={working}
                  onClick={() => void openRepo(r.id)}
                >
                  <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
                    <div>{r.modelId}</div>
                    {r.tier && <span className={tierClass(r.tier)}>{tierLabel(r.tier)}</span>}
                  </div>
                  <div className="muted" style={{ fontSize: "0.75rem" }}>
                    скачиваний {r.downloads} · лайков {r.likes}
                    {r.approxSizeBytes
                      ? ` · ~${fmtGb(r.approxSizeBytes)}${r.suggestedQuant ? ` ${r.suggestedQuant}` : ""}`
                      : ""}
                  </div>
                </button>
              );
            })}
          </div>
          {selectedHf && (
            <div className="section-block">
              <strong>Файлы {selectedHf}</strong>
              <p className="muted" style={{ fontSize: "0.78rem", margin: "4px 0 0" }}>
                ★ — рекомендуемый файл под ваше железо · цвета — подходит / медленно / не пойдёт
              </p>
              {files.map((f) => {
                const fit = f.tier ? tierGroup(f.tier) : null;
                return (
                  <div
                    key={f.path}
                    className={`row${fit ? ` fit-card-${fit}` : ""}`}
                    style={{
                      marginTop: 8,
                      justifyContent: "space-between",
                      padding: "8px 10px",
                      borderRadius: 8,
                    }}
                  >
                    <span className="mono" style={{ fontSize: "0.8rem" }}>
                      {f.path} ({fmtGb(f.size)})
                      {f.recommended ? " ★" : ""}
                      {f.tier ? (
                        <>
                          {" "}
                          <span className={tierClass(f.tier)}>{tierLabel(f.tier)}</span>
                        </>
                      ) : null}
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
                );
              })}
            </div>
          )}
        </SettingsSection>
      </div>

      {props.settings && (
        <ModelAdvancedSettings
          open={advancedOpen}
          onClose={() => setAdvancedOpen(false)}
          settings={props.settings}
          setSettings={props.setSettings}
          models={props.models}
          loadedModelId={props.loadedModelId}
          focusModelId={focusModelId}
          activeSessionId={props.activeSessionId}
          setError={props.setError}
          onHint={setHint}
        />
      )}
    </PageShell>
  );
}

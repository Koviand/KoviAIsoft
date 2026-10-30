import { useEffect, useMemo, useState } from "react";
import type { AppSettings, GenerationParams, LocalModel } from "@kovi/shared";
import { api } from "../api";

type Props = {
  open: boolean;
  onClose: () => void;
  settings: AppSettings;
  setSettings: (s: AppSettings) => void;
  models: LocalModel[];
  loadedModelId: string | null;
  /** Prefer this model for fit hints (selected / loaded). */
  focusModelId?: string | null;
  /** Sync generation defaults into this chat session (not sessions[0]). */
  activeSessionId?: string | null;
  setError: (e: string | null) => void;
  onHint?: (msg: string) => void;
};

function num(v: string, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function ModelAdvancedSettings(props: Props) {
  const model = useMemo(() => {
    const id = props.focusModelId || props.loadedModelId;
    if (!id) return props.models[0] || null;
    return props.models.find((m) => m.id === id) || null;
  }, [props.focusModelId, props.loadedModelId, props.models]);

  const [load, setLoad] = useState({
    gpuLayers: props.settings.defaultParams.gpuLayers,
    context: props.settings.defaultParams.context,
    flashAttn: Boolean(props.settings.defaultParams.flashAttn),
  });
  const [gen, setGen] = useState({
    temperature: props.settings.defaultParams.temperature,
    topP: props.settings.defaultParams.topP,
    topK: props.settings.defaultParams.topK,
    minP: props.settings.defaultParams.minP,
    maxTokens: props.settings.defaultParams.maxTokens,
    seed: props.settings.defaultParams.seed,
  });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!props.open) return;
    const d = props.settings.defaultParams;
    setLoad({
      gpuLayers: d.gpuLayers,
      context: d.context,
      flashAttn: Boolean(d.flashAttn),
    });
    setGen({
      temperature: d.temperature,
      topP: d.topP,
      topK: d.topK,
      minP: d.minP,
      maxTokens: d.maxTokens,
      seed: d.seed,
    });
  }, [props.open, props.settings.defaultParams]);

  if (!props.open) return null;

  const aggressive =
    model &&
    ((model.recommendedNgl != null && load.gpuLayers > model.recommendedNgl) ||
      (model.recommendedContext != null && load.context > model.recommendedContext) ||
      model.fitsInVram === false);

  async function saveDefaults(partial: Partial<GenerationParams>): Promise<AppSettings> {
    const next: AppSettings = {
      ...props.settings,
      defaultParams: { ...props.settings.defaultParams, ...partial },
    };
    const saved = await api.saveSettings(next);
    props.setSettings(saved);
    return saved;
  }

  async function applyGeneration(): Promise<void> {
    setBusy(true);
    try {
      await saveDefaults({
        temperature: gen.temperature,
        topP: gen.topP,
        topK: gen.topK,
        minP: gen.minP,
        maxTokens: gen.maxTokens,
        seed: gen.seed,
      });
      // Sync active session params if present.
      try {
        const sessions = await api.listSessions();
        const byId = props.activeSessionId
          ? sessions.find((s) => s.id === props.activeSessionId)
          : null;
        const active =
          byId ||
          [...sessions].sort(
            (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
          )[0];
        if (active) {
          await api.updateSession({
            ...active,
            params: {
              ...active.params,
              temperature: gen.temperature,
              topP: gen.topP,
              topK: gen.topK,
              minP: gen.minP,
              maxTokens: gen.maxTokens,
              seed: gen.seed,
            },
          });
        }
      } catch {
        // Session sync is best-effort.
      }
      props.onHint?.("Параметры генерации сохранены — применятся к следующим запросам");
    } catch (e) {
      props.setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function applyAndReload(): Promise<void> {
    setBusy(true);
    try {
      const saved = await saveDefaults({
        gpuLayers: load.gpuLayers,
        context: load.context,
        flashAttn: load.flashAttn,
        maxTokens: gen.maxTokens,
      });
      // Patch active profile numbers so next load uses them.
      const pid = saved.activeLoadProfileId;
      if (pid) {
        const profiles = (saved.loadProfiles || []).map((p) =>
          p.id === pid
            ? {
                ...p,
                gpuLayers: load.gpuLayers,
                context: load.context,
                flashAttn: load.flashAttn,
                maxTokens: gen.maxTokens,
                // Manual override — loadModel must not recalculate over these numbers.
                hardwareAware: false,
              }
            : p,
        );
        const withProfile = await api.saveSettings({ ...saved, loadProfiles: profiles });
        props.setSettings(withProfile);
      }
      const modelId = props.loadedModelId || model?.id;
      if (modelId) {
        await api.loadModel(modelId);
        props.onHint?.("Параметры загрузки применены, модель перезагружена");
      } else {
        props.onHint?.("Параметры загрузки сохранены — загрузите модель, чтобы применить");
      }
      props.onClose();
    } catch (e) {
      props.setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      style={{
        position: "fixed",
        inset: 0,
        background: "color-mix(in srgb, #000 45%, transparent)",
        zIndex: 80,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
      onClick={props.onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") props.onClose();
      }}
    >
      <div
        className="card elevated"
        role="dialog"
        aria-modal="true"
        aria-label="Продвинутые параметры модели"
        style={{
          width: "min(640px, 100%)",
          maxHeight: "90vh",
          overflow: "auto",
          margin: 0,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
          <div>
            <h3 style={{ margin: 0 }}>Продвинутые параметры модели</h3>
            <p className="muted" style={{ margin: "6px 0 0", fontSize: "0.82rem" }}>
              {model
                ? `${model.name} · ngl≈${model.recommendedNgl} · ctx≈${model.recommendedContext}${
                    model.fitsInVram === false ? " · может не влезть в VRAM" : ""
                  }`
                : "Модель не выбрана — правки сохранятся в настройки по умолчанию"}
            </p>
          </div>
          <button className="btn ghost" type="button" onClick={props.onClose}>
            Закрыть
          </button>
        </div>

        {aggressive ? (
          <p
            className="muted"
            style={{
              marginTop: 12,
              fontSize: "0.82rem",
              color: "var(--danger, #b45309)",
            }}
          >
            Значения выше рекомендованных для этой модели — возможен OOM или медленная загрузка.
          </p>
        ) : null}

        <section style={{ marginTop: 16 }}>
          <strong>Загрузка</strong>
          <p className="muted" style={{ margin: "4px 0 0", fontSize: "0.78rem" }}>
            Нужна перезагрузка модели (gpuLayers / context / flash-attn).
          </p>
          <div className="grid-2" style={{ marginTop: 10 }}>
            <label>
              GPU layers (ngl)
              <input
                className="input"
                type="number"
                value={load.gpuLayers}
                onChange={(e) =>
                  setLoad((s) => ({ ...s, gpuLayers: num(e.target.value, s.gpuLayers) }))
                }
              />
            </label>
            <label>
              Context
              <input
                className="input"
                type="number"
                value={load.context}
                onChange={(e) =>
                  setLoad((s) => ({ ...s, context: num(e.target.value, s.context) }))
                }
              />
            </label>
            <label className="row" style={{ alignItems: "center", marginTop: 8 }}>
              <input
                type="checkbox"
                checked={load.flashAttn}
                onChange={(e) => setLoad((s) => ({ ...s, flashAttn: e.target.checked }))}
              />
              Flash Attention
            </label>
          </div>
          <button
            className="btn primary"
            type="button"
            style={{ marginTop: 12 }}
            disabled={busy}
            onClick={() => void applyAndReload()}
          >
            Применить и перезагрузить
          </button>
        </section>

        <section style={{ marginTop: 20 }}>
          <strong>Генерация</strong>
          <p className="muted" style={{ margin: "4px 0 0", fontSize: "0.78rem" }}>
            Действует на следующие запросы без перезагрузки сервера.
          </p>
          <div className="grid-2" style={{ marginTop: 10 }}>
            {(
              [
                ["temperature", gen.temperature],
                ["topP", gen.topP],
                ["topK", gen.topK],
                ["minP", gen.minP],
                ["maxTokens", gen.maxTokens],
              ] as const
            ).map(([key, value]) => (
              <label key={key}>
                {key}
                <input
                  className="input"
                  type="number"
                  step="any"
                  value={value}
                  onChange={(e) =>
                    setGen((s) => ({
                      ...s,
                      [key]: num(e.target.value, value),
                    }))
                  }
                />
              </label>
            ))}
            <label>
              seed (пусто = random)
              <input
                className="input"
                type="number"
                value={gen.seed ?? ""}
                placeholder="random"
                onChange={(e) => {
                  const raw = e.target.value.trim();
                  setGen((s) => ({
                    ...s,
                    seed: raw === "" ? null : num(raw, 0),
                  }));
                }}
              />
            </label>
          </div>
          <button
            className="btn"
            type="button"
            style={{ marginTop: 12 }}
            disabled={busy}
            onClick={() => void applyGeneration()}
          >
            Применить генерацию
          </button>
        </section>
      </div>
    </div>
  );
}

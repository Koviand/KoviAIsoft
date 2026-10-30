import { useState } from "react";
import type { AgentRiskMode, AppSettings, RuntimeBackend } from "@kovi/shared";
import { api } from "../api";

export function OnboardingWizard(props: {
  settings: AppSettings;
  setSettings: (s: AppSettings) => void;
  setError: (e: string | null) => void;
  onDone: () => void;
}) {
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [backend, setBackend] = useState<RuntimeBackend | "auto">(
    props.settings.runtimeBackendPreference || "auto",
  );
  const [modelRoot, setModelRoot] = useState(props.settings.modelRoots[0] || "C:\\Models\\LFM");
  const [downloadDir, setDownloadDir] = useState(
    props.settings.downloadDir || props.settings.modelRoots[0] || "C:\\Models\\LFM",
  );
  const [projectRoot, setProjectRoot] = useState(props.settings.projectRoot || "");
  const [risk, setRisk] = useState<AgentRiskMode>(props.settings.agentRiskMode || "ask");
  const [status, setStatus] = useState("");

  async function savePartial(patch: Partial<AppSettings>): Promise<AppSettings> {
    const next = { ...props.settings, ...patch };
    const saved = await api.saveSettings(next);
    props.setSettings(saved);
    return saved;
  }

  async function finish(): Promise<void> {
    setBusy(true);
    setStatus("Сохраняю настройки…");
    try {
      const roots = [...new Set([modelRoot, downloadDir].filter(Boolean))];
      await savePartial({
        runtimeBackendPreference: backend,
        modelRoots: roots.length ? roots : [modelRoot],
        downloadDir: downloadDir || modelRoot,
        projectRoot: projectRoot || null,
        agentRiskMode: risk,
        onboardingCompleted: true,
      });
      props.onDone();
    } catch (e) {
      props.setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setStatus("");
    }
  }

  async function installRuntime(): Promise<void> {
    setBusy(true);
    setStatus("Установка llama.cpp…");
    try {
      await savePartial({ runtimeBackendPreference: backend });
      await api.ensureLatestRuntime(backend, true);
      setStatus("Движок готов");
      setStep(1);
    } catch (e) {
      props.setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="wizard-shell">
      <div className="wizard-card">
        <div className="wizard-brand">
          <span className="brand-mark" aria-hidden="true">
            K
          </span>
          <div>
            <div className="wizard-title">KoviAIsoft</div>
            <div className="muted">Первый запуск · шаг {step + 1} из 3</div>
          </div>
        </div>

        {step === 0 && (
          <section className="wizard-step">
            <h2>Движок llama.cpp</h2>
            <p className="muted">Выберите бэкенд под ваше железо — скачаем свежий билд.</p>
            <label>
              Бэкенд
              <select
                className="input"
                value={backend}
                onChange={(e) => setBackend(e.target.value as RuntimeBackend | "auto")}
              >
                <option value="auto">Авто</option>
                <option value="cuda">CUDA (NVIDIA)</option>
                <option value="vulkan">Vulkan</option>
                <option value="cpu">CPU</option>
              </select>
            </label>
            <div className="row" style={{ marginTop: 16 }}>
              <button className="btn primary" type="button" disabled={busy} onClick={() => void installRuntime()}>
                Установить и далее
              </button>
              <button className="btn ghost" type="button" disabled={busy} onClick={() => setStep(1)}>
                Пропустить
              </button>
            </div>
          </section>
        )}

        {step === 1 && (
          <section className="wizard-step">
            <h2>Папки</h2>
            <p className="muted">
              Где искать GGUF, куда сохранять загрузки с HF и корень проекта для агента (AGENTS.md).
            </p>
            <label>
              Папка моделей (сканирование)
              <div className="row">
                <input
                  className="input"
                  style={{ flex: 1 }}
                  value={modelRoot}
                  onChange={(e) => setModelRoot(e.target.value)}
                />
                <button
                  className="btn"
                  type="button"
                  onClick={async () => {
                    const p = await api.pickDirectory();
                    if (p) {
                      setModelRoot(p);
                      if (!downloadDir) setDownloadDir(p);
                    }
                  }}
                >
                  …
                </button>
              </div>
            </label>
            <label style={{ marginTop: 12, display: "block" }}>
              Папка загрузки моделей
              <div className="row">
                <input
                  className="input"
                  style={{ flex: 1 }}
                  value={downloadDir}
                  onChange={(e) => setDownloadDir(e.target.value)}
                />
                <button
                  className="btn"
                  type="button"
                  onClick={async () => {
                    const p = await api.pickDirectory();
                    if (p) setDownloadDir(p);
                  }}
                >
                  …
                </button>
              </div>
            </label>
            <label style={{ marginTop: 12, display: "block" }}>
              Папка проекта
              <div className="row">
                <input
                  className="input"
                  style={{ flex: 1 }}
                  value={projectRoot}
                  onChange={(e) => setProjectRoot(e.target.value)}
                  placeholder="необязательно"
                />
                <button
                  className="btn"
                  type="button"
                  onClick={async () => {
                    const p = await api.pickDirectory();
                    if (p) setProjectRoot(p);
                  }}
                >
                  …
                </button>
              </div>
            </label>
            <div className="row" style={{ marginTop: 16 }}>
              <button className="btn" type="button" onClick={() => setStep(0)}>
                Назад
              </button>
              <button className="btn primary" type="button" onClick={() => setStep(2)}>
                Далее
              </button>
            </div>
          </section>
        )}

        {step === 2 && (
          <section className="wizard-step">
            <h2>Режим агента и модели</h2>
            <p className="muted">
              Ask — спрашивать всегда; Auto-safe — тихо в проекте; Full — почти без подтверждений.
            </p>
            <label>
              Подтверждения
              <select
                className="input"
                value={risk}
                onChange={(e) => setRisk(e.target.value as AgentRiskMode)}
              >
                <option value="ask">Ask</option>
                <option value="auto-safe">Auto-safe</option>
                <option value="full">Full</option>
              </select>
            </label>
            <p className="muted" style={{ marginTop: 12 }}>
              После мастера откройте «Модели» → обновите список → «Загрузить в память».
            </p>
            <div className="row" style={{ marginTop: 16 }}>
              <button className="btn" type="button" onClick={() => setStep(1)}>
                Назад
              </button>
              <button className="btn primary" type="button" disabled={busy} onClick={() => void finish()}>
                Готово
              </button>
            </div>
          </section>
        )}

        {status ? <div className="muted" style={{ marginTop: 12 }}>{status}</div> : null}
      </div>
    </div>
  );
}

import { useState } from "react";
import { api } from "./api";
import { Topbar } from "./components/Topbar";
import { useAppState } from "./hooks/useAppState";
import { riskRu } from "./lib/labels";
import { ChatPage } from "./pages/ChatPage";
import { McpPage } from "./pages/McpPage";
import { ModelsPage } from "./pages/ModelsPage";
import { OnboardingWizard } from "./pages/OnboardingWizard";
import { RuntimePage } from "./pages/RuntimePage";
import { SettingsPage } from "./pages/SettingsPage";

export function App() {
  const state = useAppState();
  const [logHint, setLogHint] = useState<string | null>(null);

  if (state.booting) {
    return (
      <div className="splash-shell">
        <div className="splash-card">
          <span className="brand-mark splash-mark" aria-hidden="true">
            K
          </span>
          <div className="splash-title">KoviAIsoft</div>
          <div className="muted">Загрузка…</div>
        </div>
      </div>
    );
  }

  if (state.settings && state.settings.onboardingCompleted === false) {
    return (
      <OnboardingWizard
        settings={state.settings}
        setSettings={state.setSettings}
        setError={state.setError}
        onDone={() => void state.refresh()}
      />
    );
  }

  return (
    <div className="app-shell">
      <Topbar
        view={state.view}
        onChange={state.setView}
        status={state.status}
        generating={state.generating}
        booting={state.booting}
        models={state.models}
        onLoadModel={(modelId) => {
          void api
            .loadModel(modelId)
            .then(() => state.refresh())
            .catch((e) => state.setError(e instanceof Error ? e.message : String(e)));
        }}
        onStop={() => {
          void api
            .stopGeneration()
            .finally(() => {
              state.setGenerating(false);
              if (state.activeSessionId) {
                void api.getMessages(state.activeSessionId).then(state.setMessages);
              }
            });
        }}
      />
      <main className="main">
        {state.error && (
          <div className="confirm-banner error-banner" role="alert">
            <div>
              <strong>Ошибка</strong>
              <div>{state.error}</div>
              {logHint ? <div className="muted" style={{ marginTop: 6 }}>{logHint}</div> : null}
            </div>
            <div className="row">
              <button
                className="btn"
                type="button"
                onClick={async () => {
                  try {
                    const log = await api.getErrorLog();
                    await navigator.clipboard.writeText(`${state.error}\n\n${log}`);
                    setLogHint("Лог скопирован в буфер");
                  } catch (e) {
                    setLogHint(e instanceof Error ? e.message : String(e));
                  }
                }}
              >
                Копировать лог
              </button>
              <button
                className="btn"
                type="button"
                onClick={() => {
                  state.setError(null);
                  setLogHint(null);
                }}
              >
                Закрыть
              </button>
            </div>
          </div>
        )}
        {state.pendingConfirm && (
          <div className="confirm-banner" role="alertdialog" aria-label="Подтверждение действия">
            <div style={{ minWidth: 0, flex: 1 }}>
              <strong>Нужно подтверждение ({riskRu(state.pendingConfirm.risk)})</strong>
              <div className="mono" style={{ marginTop: 6 }}>
                {state.pendingConfirm.summary}
              </div>
              {state.pendingConfirm.diff ? (
                <pre className="diff-preview">{state.pendingConfirm.diff}</pre>
              ) : null}
            </div>
            <div className="row" style={{ marginTop: 10, flexWrap: "wrap" }}>
              <button
                className="btn primary"
                type="button"
                disabled={state.confirmBusy}
                onClick={() => void state.resolvePendingConfirm(true)}
              >
                Разрешить
              </button>
              <button
                className="btn"
                type="button"
                disabled={state.confirmBusy}
                onClick={() => void state.resolvePendingConfirm(true, true)}
              >
                Разрешить до конца диалога
              </button>
              <button
                className="btn danger"
                type="button"
                disabled={state.confirmBusy}
                onClick={() => void state.resolvePendingConfirm(false)}
              >
                Отклонить
              </button>
            </div>
          </div>
        )}
        {state.view === "chat" && (
          <ChatPage
            sessions={state.sessions}
            activeSessionId={state.activeSessionId}
            messages={state.messages}
            busy={state.generating}
            settings={state.settings}
            setSessions={state.setSessions}
            setActiveSessionId={state.setActiveSessionId}
            setMessages={state.setMessages}
            setBusy={state.setGenerating}
            setError={state.setError}
            setSettings={state.setSettings}
          />
        )}
        {state.view === "models" && (
          <ModelsPage
            models={state.models}
            loadedModelId={state.runtime?.loadedModelId ?? null}
            settings={state.settings}
            setModels={state.setModels}
            setSettings={state.setSettings}
            setError={state.setError}
            refresh={state.refresh}
          />
        )}
        {state.view === "runtime" && (
          <RuntimePage
            system={state.system}
            runtime={state.runtime}
            setError={state.setError}
            refresh={state.refresh}
          />
        )}
        {state.view === "mcp" && (
          <McpPage
            settings={state.settings}
            setSettings={state.setSettings}
            setError={state.setError}
          />
        )}
        {state.view === "settings" && (
          <SettingsPage
            settings={state.settings}
            setSettings={state.setSettings}
            setError={state.setError}
          />
        )}
      </main>
    </div>
  );
}

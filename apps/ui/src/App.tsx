import { api } from "./api";
import { Topbar } from "./components/Topbar";
import { useAppState } from "./hooks/useAppState";
import { riskRu } from "./lib/labels";
import { ChatPage } from "./pages/ChatPage";
import { McpPage } from "./pages/McpPage";
import { ModelsPage } from "./pages/ModelsPage";
import { RuntimePage } from "./pages/RuntimePage";
import { SettingsPage } from "./pages/SettingsPage";

export function App() {
  const state = useAppState();

  return (
    <div className="app-shell">
      <Topbar
        view={state.view}
        onChange={state.setView}
        status={state.status}
        generating={state.generating}
        booting={state.booting}
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
            </div>
            <button className="btn" type="button" onClick={() => state.setError(null)}>
              Закрыть
            </button>
          </div>
        )}
        {state.pendingConfirm && (
          <div className="confirm-banner" role="alertdialog" aria-label="Подтверждение действия">
            <div>
              <strong>Нужно подтверждение ({riskRu(state.pendingConfirm.risk)})</strong>
              <div className="mono" style={{ marginTop: 6 }}>
                {state.pendingConfirm.summary}
              </div>
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
            setSessions={state.setSessions}
            setActiveSessionId={state.setActiveSessionId}
            setMessages={state.setMessages}
            setBusy={state.setGenerating}
            setError={state.setError}
          />
        )}
        {state.view === "models" && (
          <ModelsPage
            models={state.models}
            loadedModelId={state.runtime?.loadedModelId ?? null}
            setModels={state.setModels}
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

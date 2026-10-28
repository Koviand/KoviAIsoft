import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { useAppState } from "./hooks/useAppState";
import { ChatPage } from "./pages/ChatPage";
import { McpPage } from "./pages/McpPage";
import { ModelsPage } from "./pages/ModelsPage";
import { RuntimePage } from "./pages/RuntimePage";
import { SettingsPage } from "./pages/SettingsPage";

export function App() {
  const state = useAppState();

  return (
    <div className="app-shell">
      <Sidebar view={state.view} onChange={state.setView} />
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
      <StatusBar status={state.status} generating={state.generating} booting={state.booting} />
    </div>
  );
}

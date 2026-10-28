import { useEffect, useMemo, useRef, useState } from "react";
import type { AppSettings, ChatMessage, ChatSession } from "@kovi/shared";
import { sessionToolsEnabled } from "@kovi/shared";
import { api } from "../api";
import { paramLabel, statusRu } from "../lib/labels";

const PROMPT_CHIPS = [
  "Кратко объясни, что умеет этот чат",
  "Помоги настроить локальную модель",
  "@agent проверь runtime и статус сервера",
];

function roleLabel(m: ChatMessage): string {
  if (m.role === "user") return "Вы";
  if (m.role === "assistant") return "Ассистент";
  if (m.role === "tool") return m.toolName ? `Инструмент · ${m.toolName}` : "Инструмент";
  if (m.role === "system") return "Система";
  return m.role;
}

function looksLikeAgentPrefix(text: string): boolean {
  return /^(@agent|\/agent)\b/i.test(text.trim());
}

function sessionInitial(title: string): string {
  const t = title.trim();
  if (!t) return "Д";
  return t.slice(0, 1).toUpperCase();
}

export function ChatPage(props: {
  sessions: ChatSession[];
  activeSessionId: string | null;
  messages: ChatMessage[];
  busy: boolean;
  settings: AppSettings | null;
  setSessions: (s: ChatSession[]) => void;
  setActiveSessionId: (id: string | null) => void;
  setMessages: (m: ChatMessage[]) => void;
  setBusy: (b: boolean) => void;
  setError: (e: string | null) => void;
  setSettings: (s: AppSettings) => void;
}) {
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState("");
  const [thinking, setThinking] = useState("");
  const [plan, setPlan] = useState<Array<{ id: string; title: string; status: string }>>([]);
  const [toolTrail, setToolTrail] = useState<
    Array<{ callId: string; name: string; status: "running" | "done" | "error"; detail?: string }>
  >([]);
  const [agentOn, setAgentOn] = useState(false);
  const [showParams, setShowParams] = useState(false);
  const [sessionQuery, setSessionQuery] = useState("");
  const [folderFilter, setFolderFilter] = useState<string>("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const activeIdRef = useRef(props.activeSessionId);
  /** Session currently receiving a stream — survives activeSessionId race on first send. */
  const streamSessionRef = useRef<string | null>(null);
  const paramTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  activeIdRef.current = props.activeSessionId;

  const activeSession = useMemo(
    () => props.sessions.find((s) => s.id === props.activeSessionId) || null,
    [props.sessions, props.activeSessionId],
  );

  const folders = useMemo(() => {
    const fromSessions = props.sessions
      .map((s) => s.folder)
      .filter((f): f is string => Boolean(f && f.trim()));
    const catalog = props.settings?.sessionFolders || [];
    return [...new Set([...catalog, ...fromSessions])].sort((a, b) => a.localeCompare(b));
  }, [props.sessions, props.settings?.sessionFolders]);

  const filteredSessions = useMemo(() => {
    const q = sessionQuery.trim().toLowerCase();
    return props.sessions.filter((s) => {
      if (folderFilter && (s.folder || "") !== folderFilter) return false;
      if (!q) return true;
      return s.title.toLowerCase().includes(q) || (s.folder || "").toLowerCase().includes(q);
    });
  }, [props.sessions, sessionQuery, folderFilter]);

  useEffect(() => {
    if (!activeSession) {
      setAgentOn(false);
      return;
    }
    setAgentOn(sessionToolsEnabled(activeSession));
    // Never wipe an in-flight stream when setActiveSessionId fires mid-send.
    if (streamSessionRef.current && streamSessionRef.current === activeSession.id) {
      return;
    }
    setPlan([]);
    setToolTrail([]);
    setStreaming("");
    setThinking("");
  }, [activeSession?.id]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [props.messages, streaming, thinking, plan, toolTrail, props.busy]);

  function acceptsStream(sessionId: string): boolean {
    return (
      sessionId === activeIdRef.current ||
      sessionId === streamSessionRef.current
    );
  }

  useEffect(() => {
    const offToken = api.onChatToken((p) => {
      if (!acceptsStream(p.sessionId)) return;
      if (p.thinking) setThinking((t) => t + p.text);
      else setStreaming((t) => t + p.text);
    });
    const offAgent = api.onAgentEvent((p) => {
      if (!acceptsStream(p.sessionId)) return;
      const ev = p.event;
      if (ev.type === "token") setStreaming((t) => t + ev.text);
      if (ev.type === "thinking") setThinking((t) => t + (t ? "\n" : "") + ev.text);
      if (ev.type === "plan") {
        setPlan(ev.steps);
        // Coding runs should flip UI into agent mode for visibility.
        setAgentOn(true);
      }
      if (ev.type === "tool_call") {
        setToolTrail((prev) => [
          ...prev.filter((t) => t.callId !== ev.callId),
          { callId: ev.callId, name: ev.name, status: "running" },
        ]);
      }
      if (ev.type === "tool_result") {
        setToolTrail((prev) =>
          prev.map((t) =>
            t.callId === ev.callId
              ? {
                  ...t,
                  status: ev.isError ? "error" : "done",
                  detail: ev.result.slice(0, 180),
                }
              : t,
          ),
        );
        if (activeIdRef.current) {
          void api.getMessages(activeIdRef.current).then(props.setMessages);
        }
      }
      if (ev.type === "done" || ev.type === "cancelled" || ev.type === "error") {
        streamSessionRef.current = null;
        setStreaming("");
        setThinking("");
        props.setBusy(false);
        if (activeIdRef.current) {
          void api.getMessages(activeIdRef.current).then(props.setMessages);
          void api.listSessions().then(props.setSessions);
        }
        if (ev.type === "error") props.setError(ev.message);
      }
    });
    return () => {
      offToken();
      offAgent();
    };
  }, [props.setBusy, props.setError, props.setMessages, props.setSessions]);

  useEffect(() => {
    return () => {
      if (paramTimer.current) clearTimeout(paramTimer.current);
    };
  }, []);

  /** Create session without activating until we have content (avoids wiping optimistic UI). */
  async function ensureSessionId(): Promise<{ id: string; existed: boolean }> {
    if (props.activeSessionId) return { id: props.activeSessionId, existed: true };
    const session = await api.createSession("chat");
    props.setSessions(await api.listSessions());
    return { id: session.id, existed: false };
  }

  async function persistAgentPref(enabled: boolean): Promise<void> {
    setAgentOn(enabled);
    if (!activeSession) return;
    try {
      const next: ChatSession = {
        ...activeSession,
        toolsEnabled: enabled,
        mode: enabled ? "agent" : "chat",
      };
      await api.updateSession(next);
      props.setSessions(await api.listSessions());
    } catch (e) {
      setAgentOn(!enabled);
      props.setError(e instanceof Error ? e.message : String(e));
    }
  }

  function scheduleSessionPatch(next: ChatSession): void {
    if (paramTimer.current) clearTimeout(paramTimer.current);
    paramTimer.current = setTimeout(() => {
      void api
        .updateSession(next)
        .then(async () => props.setSessions(await api.listSessions()))
        .catch((e) => props.setError(e instanceof Error ? e.message : String(e)));
    }, 400);
  }

  async function onSend(overrideText?: string): Promise<void> {
    const text = (overrideText ?? input).trim();
    if (!text || props.busy) return;
    const useAgent = agentOn || looksLikeAgentPrefix(text);
    setInput("");
    setStreaming("");
    setThinking("");
    setPlan([]);
    setToolTrail([]);
    props.setBusy(true);
    props.setError(null);
    try {
      const { id: sessionId, existed } = await ensureSessionId();
      // Pin stream target before React re-renders so early tokens are not dropped.
      streamSessionRef.current = sessionId;
      activeIdRef.current = sessionId;
      const baseMsgs = existed ? props.messages : [];
      const optimistic: ChatMessage = {
        id: `tmp-user-${Date.now()}`,
        role: "user",
        content: text,
        createdAt: new Date().toISOString(),
      };
      props.setActiveSessionId(sessionId);
      props.setMessages([...baseMsgs, optimistic]);

      const result = await api.sendMessage({
        sessionId,
        content: text,
        useAgent,
      });
      if (!useAgent) {
        const msgs = await api.getMessages(sessionId);
        props.setMessages(msgs);
        setStreaming("");
        setThinking("");
        streamSessionRef.current = null;
        props.setBusy(false);
        props.setSessions(await api.listSessions());
        void result;
      }
    } catch (e) {
      streamSessionRef.current = null;
      props.setError(e instanceof Error ? e.message : String(e));
      props.setBusy(false);
    }
  }

  async function onStop(): Promise<void> {
    try {
      await api.stopGeneration();
    } finally {
      streamSessionRef.current = null;
      props.setBusy(false);
      setStreaming("");
      setThinking("");
      if (props.activeSessionId) {
        props.setMessages(await api.getMessages(props.activeSessionId));
      }
    }
  }

  async function onDeleteSession(id: string): Promise<void> {
    try {
      await api.deleteSession(id);
      const all = await api.listSessions();
      props.setSessions(all);
      if (props.activeSessionId === id) {
        props.setActiveSessionId(all[0]?.id ?? null);
      }
    } catch (e) {
      props.setError(e instanceof Error ? e.message : String(e));
    }
  }

  const isEmpty = props.messages.length === 0 && !streaming && !thinking;

  async function exportActive(): Promise<void> {
    if (!props.activeSessionId) return;
    try {
      const bundle = await api.exportSession(props.activeSessionId);
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `kovi-session-${props.activeSessionId.slice(0, 8)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      props.setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function importSessionFile(file: File): Promise<void> {
    try {
      const text = await file.text();
      const bundle = JSON.parse(text);
      const session = await api.importSession(bundle);
      props.setSessions(await api.listSessions());
      props.setActiveSessionId(session.id);
    } catch (e) {
      props.setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function setSessionFolder(folder: string): Promise<void> {
    if (!activeSession) return;
    try {
      const next = { ...activeSession, folder: folder.trim() || undefined };
      await api.updateSession(next);
      props.setSessions(await api.listSessions());
      if (folder.trim() && props.settings) {
        const foldersNext = [...new Set([...(props.settings.sessionFolders || []), folder.trim()])];
        const saved = await api.saveSettings({ ...props.settings, sessionFolders: foldersNext });
        props.setSettings(saved);
      }
    } catch (e) {
      props.setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="panel chat-panel">
      <div className="panel-list">
        <div className="row session-list-head">
          <button
            className="btn primary"
            type="button"
            onClick={async () => {
              try {
                const s = await api.createSession("chat");
                props.setSessions(await api.listSessions());
                props.setActiveSessionId(s.id);
              } catch (e) {
                props.setError(e instanceof Error ? e.message : String(e));
              }
            }}
          >
            Новый диалог
          </button>
          <label className="btn ghost" style={{ cursor: "pointer" }}>
            Импорт
            <input
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importSessionFile(f);
                e.target.value = "";
              }}
            />
          </label>
        </div>
        <input
          className="input session-search"
          placeholder="Поиск диалогов…"
          value={sessionQuery}
          onChange={(e) => setSessionQuery(e.target.value)}
        />
        {folders.length > 0 && (
          <select
            className="select session-folder-filter"
            value={folderFilter}
            onChange={(e) => setFolderFilter(e.target.value)}
          >
            <option value="">Все папки</option>
            {folders.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        )}
        {filteredSessions.length === 0 && (
          <div className="empty-hint">
            {props.sessions.length === 0
              ? "Пока нет диалогов — создайте первый."
              : "Ничего не найдено."}
          </div>
        )}
        {filteredSessions.map((s) => (
          <div
            key={s.id}
            className={`list-item session-item ${props.activeSessionId === s.id ? "active" : ""}`}
          >
            <button
              type="button"
              className="session-select"
              onClick={() => props.setActiveSessionId(s.id)}
            >
              <span className="session-avatar" aria-hidden="true">
                {sessionInitial(s.title)}
              </span>
              <span>
                <div className="session-title">
                  {s.title}
                  {sessionToolsEnabled(s) ? <span className="badge">агент</span> : null}
                </div>
                <div className="muted session-meta">
                  {s.folder ? `${s.folder} · ` : ""}
                  {new Date(s.updatedAt).toLocaleString()}
                </div>
              </span>
            </button>
            <button
              type="button"
              className="btn ghost icon-btn"
              title="Удалить"
              onClick={() => void onDeleteSession(s.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <div className="panel-main chat-main">
        <header className="chat-header">
          <div>
            <h1 className="h1">{activeSession?.title || "Диалог"}</h1>
            <p className="muted chat-sub">
              Обычный ответ или режим «Агент» (файлы, терминал, web). Enter — отправить
            </p>
          </div>
          <div className="row" style={{ flexWrap: "wrap" }}>
            {activeSession ? (
              <input
                className="input"
                style={{ width: 140 }}
                placeholder="Папка"
                defaultValue={activeSession.folder || ""}
                key={`folder-${activeSession.id}-${activeSession.folder || ""}`}
                onBlur={(e) => void setSessionFolder(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.currentTarget.blur();
                  }
                }}
              />
            ) : null}
            <button className="btn ghost" type="button" disabled={!activeSession} onClick={() => void exportActive()}>
              Экспорт
            </button>
            <button
              className="btn ghost"
              type="button"
              onClick={() => setShowParams((v) => !v)}
            >
              {showParams ? "Скрыть параметры" : "Параметры"}
            </button>
            <button className="btn" type="button" disabled={!props.busy} onClick={() => void onStop()}>
              Стоп
            </button>
          </div>
        </header>

        <div className="chat-scroll">
          <div className="chat-column">
            {activeSession && showParams && (
              <div className="card params-card">
                <div className="muted" style={{ fontSize: "0.8rem", marginBottom: 8 }}>
                  Параметры только для этого диалога (сохраняются автоматически)
                </div>
                <div className="row">
                  {(
                    [
                      ["temperature", activeSession.params.temperature],
                      ["topP", activeSession.params.topP],
                      ["maxTokens", activeSession.params.maxTokens],
                      ["context", activeSession.params.context],
                      ["gpuLayers", activeSession.params.gpuLayers],
                    ] as const
                  ).map(([key, value]) => (
                    <label key={key} className="param-field">
                      <span className="muted">{paramLabel(key)}</span>
                      <input
                        className="input"
                        type="number"
                        step="any"
                        value={value}
                        onChange={(e) => {
                          const next = {
                            ...activeSession,
                            params: { ...activeSession.params, [key]: Number(e.target.value) },
                          };
                          props.setSessions(
                            props.sessions.map((s) => (s.id === next.id ? next : s)),
                          );
                          scheduleSessionPatch(next);
                        }}
                      />
                    </label>
                  ))}
                </div>
                <label className="muted" style={{ display: "block", marginTop: 10, fontSize: "0.8rem" }}>
                  Системный промпт
                  <textarea
                    className="textarea"
                    style={{ marginTop: 6, minHeight: 56 }}
                    value={activeSession.systemPrompt}
                    onChange={(e) => {
                      const next = { ...activeSession, systemPrompt: e.target.value };
                      props.setSessions(
                        props.sessions.map((s) => (s.id === next.id ? next : s)),
                      );
                      scheduleSessionPatch(next);
                    }}
                  />
                </label>
              </div>
            )}

            {plan.length > 0 && (
              <div className="card plan-list">
                <strong>План агента</strong>
                {plan.map((p) => (
                  <div key={p.id} className={`plan-item status-${p.status}`}>
                    <span className="plan-status">{statusRu(p.status)}</span>
                    <span>{p.title}</span>
                  </div>
                ))}
              </div>
            )}

            {toolTrail.length > 0 && (
              <div className="tool-trail" style={{ width: "100%", padding: 0, margin: 0 }}>
                {toolTrail.map((t) => (
                  <div key={t.callId} className={`tool-chip status-${t.status}`}>
                    <span className="mono">{t.name}</span>
                    <span className="muted">{statusRu(t.status)}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="messages">
              {isEmpty && (
                <div className="empty-chat">
                  <div className="empty-chat-brand">
                    Kovi<span>AI</span>soft
                  </div>
                  <p className="muted">
                    Загрузите модель во вкладке «Модели», затем напишите сюда. Режим «Агент» —
                    для файлов, терминала и инструментов.
                  </p>
                  <div className="prompt-chips">
                    {PROMPT_CHIPS.map((chip) => (
                      <button
                        key={chip}
                        type="button"
                        className="prompt-chip"
                        disabled={props.busy}
                        onClick={() => void onSend(chip)}
                      >
                        {chip}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {props.messages.map((m) => (
                <div key={m.id} className={`msg ${m.role} msg-enter`}>
                  <div className="role">{roleLabel(m)}</div>
                  {m.thinking ? <div className="thinking">{m.thinking}</div> : null}
                  <div className="msg-body">{m.content}</div>
                </div>
              ))}
              {props.busy && !streaming && !thinking && (
                <div className="msg assistant msg-enter streaming" aria-live="polite">
                  <div className="role">Ассистент</div>
                  <div className="msg-body gen-pending">
                    <span className="gen-dots" aria-hidden="true" />
                    {agentOn
                      ? "Агент думает и готовит шаги…"
                      : "Модель обрабатывает запрос (prefill)…"}
                  </div>
                </div>
              )}
              {(streaming || thinking) && (
                <div className="msg assistant msg-enter streaming" aria-live="polite">
                  <div className="role">Ассистент</div>
                  {thinking ? (
                    <div className="thinking">
                      <div className="thinking-label">Размышление</div>
                      {thinking}
                      {!streaming ? <span className="caret" aria-hidden="true" /> : null}
                    </div>
                  ) : null}
                  <div className="msg-body">
                    {streaming}
                    {streaming ? <span className="caret" aria-hidden="true" /> : null}
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          </div>
        </div>

        <div className="composer-dock">
          <div className="composer">
            <div className="composer-toolbar">
              <div className="segmented" role="group" aria-label="Режим">
                <button
                  type="button"
                  className={!agentOn ? "on" : ""}
                  onClick={() => void persistAgentPref(false)}
                >
                  Чат
                </button>
                <button
                  type="button"
                  className={agentOn ? "on" : ""}
                  onClick={() => void persistAgentPref(true)}
                >
                  Агент
                </button>
              </div>
              <span className="muted composer-hint">
                {agentOn
                  ? "Агент пишет файлы и выполняет план — подтвердите опасные шаги"
                  : "Чат отвечает текстом. Запросы вроде «напиши игру/код» сами включают агента"}
              </span>
            </div>
            <textarea
              className="textarea composer-input"
              value={input}
              placeholder={
                agentOn
                  ? "Опишите задачу агенту…"
                  : "Сообщение… Enter — отправить, Shift+Enter — новая строка"
              }
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void onSend();
                }
              }}
            />
            <div className="composer-actions">
              <button
                className="btn primary"
                type="button"
                disabled={props.busy || !input.trim()}
                onClick={() => void onSend()}
              >
                {agentOn ? "Запустить агента" : "Отправить"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

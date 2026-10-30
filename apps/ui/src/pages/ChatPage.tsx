import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentPlanStep,
  AppSettings,
  ChatMessage,
  ChatSession,
  RuntimeStatus,
} from "@kovi/shared";
import { api } from "../api";
import {
  ProcessTimeline,
  type ProcessMode,
  type ProcessToolItem,
} from "../components/ProcessTimeline";
import {
  MentionPicker,
  applyMention,
  buildMentionItems,
  mentionQueryAt,
} from "../components/MentionPicker";
import { paramLabel } from "../lib/labels";

const RESUME_PROMPT =
  "Продолжи задачу с того места, где остановился. Не начинай план заново — используй рабочую память и уже записанные файлы. Один JSON-шаг: tool или final.";

function canResumeAgent(session: ChatSession | null, messages: ChatMessage[]): boolean {
  if (!session) return false;
  if (session.agentScratchpad && session.agentScratchpad.length > 8) return true;
  const last = [...messages].reverse().find((m) => m.role === "assistant");
  if (!last?.content) return false;
  return /лимит шагов|незаверш|incomplete|отмен|останов|продолж/i.test(last.content);
}

function resumePromptFor(session: ChatSession | null): string {
  let goal = "";
  try {
    if (session?.agentScratchpad) {
      const parsed = JSON.parse(session.agentScratchpad) as { goal?: string };
      if (typeof parsed.goal === "string" && parsed.goal.trim()) {
        goal = parsed.goal.trim().slice(0, 240);
      }
    }
  } catch {
    // ignore
  }
  if (!goal) return RESUME_PROMPT;
  return (
    `Продолжи задачу с того места, где остановился. Цель была: ${goal}. ` +
    `Не начинай план заново — используй рабочую память и уже записанные файлы. Один JSON-шаг: tool или final.`
  );
}

const PROMPT_CHIPS = [
  "Кратко объясни, что умеет этот чат",
  "@codebase где точка входа приложения?",
  "@agent проверь runtime и статус сервера",
];

function roleLabel(m: ChatMessage): string {
  if (m.role === "user") return "Вы";
  if (m.role === "assistant") return "Ассистент";
  if (m.role === "tool") return m.toolName ? `Инструмент · ${m.toolName}` : "Инструмент";
  if (m.role === "system") return "Система";
  return m.role;
}

function sessionInitial(title: string): string {
  const t = title.trim();
  if (!t) return "Д";
  return t.slice(0, 1).toUpperCase();
}

function shortArgs(args: Record<string, unknown>): string {
  try {
    const keys = Object.keys(args);
    if (!keys.length) return "";
    const pick: Record<string, unknown> = {};
    for (const k of keys.slice(0, 4)) {
      const v = args[k];
      if (typeof v === "string" && v.length > 80) pick[k] = `${v.slice(0, 80)}…`;
      else pick[k] = v;
    }
    const s = JSON.stringify(pick);
    return s.length > 160 ? `${s.slice(0, 160)}…` : s;
  } catch {
    return "";
  }
}

export function ChatPage(props: {
  sessions: ChatSession[];
  activeSessionId: string | null;
  messages: ChatMessage[];
  busy: boolean;
  settings: AppSettings | null;
  runtime?: RuntimeStatus | null;
  pendingConfirmSummary?: string | null;
  setSessions: (s: ChatSession[]) => void;
  setActiveSessionId: (id: string | null) => void;
  setMessages: (m: ChatMessage[]) => void;
  setBusy: (b: boolean) => void;
  setError: (e: string | null) => void;
  setSettings: (s: AppSettings) => void;
  onOpenModels?: () => void;
}) {
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState("");
  const [thinking, setThinking] = useState("");
  const [modelOutput, setModelOutput] = useState("");
  const [currentStep, setCurrentStep] = useState<string | null>(null);
  const [plan, setPlan] = useState<AgentPlanStep[]>([]);
  const [toolTrail, setToolTrail] = useState<ProcessToolItem[]>([]);
  const [genMode, setGenMode] = useState<ProcessMode>(null);
  const [showParams, setShowParams] = useState(false);
  const [sessionQuery, setSessionQuery] = useState("");
  const [folderFilter, setFolderFilter] = useState<string>("");
  const [composerCaret, setComposerCaret] = useState(0);
  const [mentionOpen, setMentionOpen] = useState(true);
  const [mentionFiles, setMentionFiles] = useState<string[]>([]);
  const [mentionHi, setMentionHi] = useState(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!mentionOpen || !mentionQueryAt(input, composerCaret)) return;
    let cancelled = false;
    void api
      .listProjectMentions()
      .then((r) => {
        if (!cancelled) setMentionFiles(r.files);
      })
      .catch(() => {
        if (!cancelled) setMentionFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [mentionOpen, input, composerCaret]);
  const activeIdRef = useRef(props.activeSessionId);
  /** Session that owns the in-flight generation (null after terminal event). */
  const streamSessionRef = useRef<string | null>(null);
  /** Bumped on each send/stop so stale timers and late tokens are ignored. */
  const generationEpochRef = useRef(0);
  const paramTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const folderTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
    if (!activeSession) return;
    if (streamSessionRef.current && streamSessionRef.current === activeSession.id) {
      return;
    }
    setPlan([]);
    setToolTrail([]);
    setStreaming("");
    setThinking("");
    setModelOutput("");
    setCurrentStep(null);
    setGenMode(null);
  }, [activeSession?.id]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [props.messages, streaming, thinking, modelOutput, plan, toolTrail, props.busy]);

  /** UI content updates only for the viewed session + current generation. */
  function acceptsUiUpdate(sessionId: string, epoch: number): boolean {
    if (epoch !== generationEpochRef.current) return false;
    if (sessionId !== activeIdRef.current) return false;
    if (streamSessionRef.current && sessionId !== streamSessionRef.current) return false;
    return true;
  }

  // Unified generation bus (chat stream + agent tools).
  useEffect(() => {
    const offAgent = api.onAgentEvent((p) => {
      const epochAtEvent = generationEpochRef.current;
      const ev = p.event;
      const isTerminal =
        ev.type === "done" || ev.type === "cancelled" || ev.type === "error";

      // Always release busy for our in-flight generation even if user switched sessions.
      if (isTerminal) {
        const owns =
          p.sessionId === streamSessionRef.current ||
          (streamSessionRef.current == null && p.sessionId === activeIdRef.current);
        if (owns || epochAtEvent === generationEpochRef.current) {
          if (p.sessionId === streamSessionRef.current) {
            streamSessionRef.current = null;
          }
          props.setBusy(false);
          if (ev.type === "error" && acceptsUiUpdate(p.sessionId, epochAtEvent)) {
            props.setError(ev.message);
          }
          const clearEpoch = epochAtEvent;
          setTimeout(() => {
            if (generationEpochRef.current !== clearEpoch) return;
            if (activeIdRef.current !== p.sessionId) return;
            setStreaming("");
            setThinking("");
            setModelOutput("");
            setCurrentStep(null);
            setGenMode(null);
            setPlan([]);
            setToolTrail([]);
          }, 400);
          if (p.sessionId === activeIdRef.current) {
            void api.getMessages(p.sessionId).then((msgs) => {
              if (generationEpochRef.current !== clearEpoch) return;
              if (activeIdRef.current !== p.sessionId) return;
              props.setMessages(msgs);
            });
          }
        }
        return;
      }

      if (!acceptsUiUpdate(p.sessionId, epochAtEvent)) return;

      if (ev.type === "started") {
        setPlan([]);
        setToolTrail([]);
        setStreaming("");
        setThinking("");
        setModelOutput("");
        setCurrentStep(null);
        setGenMode(ev.mode);
        props.setBusy(true);
      }
      // Prefer stream only; ignore legacy token duplicates (P0-4).
      if (ev.type === "stream") {
        setStreaming((t) => t + ev.text);
      }
      if (ev.type === "model_output") {
        setModelOutput((t) => t + ev.text);
      }
      if (ev.type === "thinking") {
        setThinking((t) => t + (t ? "\n" : "") + ev.text);
      }
      if (ev.type === "plan") {
        setPlan(ev.steps);
      }
      if (ev.type === "step_start") {
        setCurrentStep(ev.stepId);
        setModelOutput("");
        setPlan((prev) =>
          prev.map((s) => (s.id === ev.stepId ? { ...s, status: "running" as const } : s)),
        );
      }
      if (ev.type === "step_done") {
        setPlan((prev) =>
          prev.map((s) =>
            s.id === ev.stepId
              ? { ...s, status: "done" as const, detail: ev.detail }
              : s,
          ),
        );
      }
      if (ev.type === "tool_call") {
        setCurrentStep(`tool · ${ev.name}`);
        setToolTrail((prev) => [
          ...prev.filter((t) => t.callId !== ev.callId),
          {
            callId: ev.callId,
            name: ev.name,
            status: "running",
            argsPreview: shortArgs(ev.args),
          },
        ]);
      }
      if (ev.type === "tool_result") {
        setToolTrail((prev) =>
          prev.map((t) =>
            t.callId === ev.callId
              ? {
                  ...t,
                  status: ev.isError ? "error" : "done",
                  detail: ev.result.slice(0, 1200),
                }
              : t,
          ),
        );
      }
    });
    return () => {
      offAgent();
    };
  }, []);

  useEffect(() => {
    return () => {
      if (paramTimer.current) clearTimeout(paramTimer.current);
      if (folderTimer.current) clearTimeout(folderTimer.current);
    };
  }, []);

  async function ensureSessionId(): Promise<{ id: string; existed: boolean }> {
    if (props.activeSessionId) return { id: props.activeSessionId, existed: true };
    const session = await api.createSession("chat");
    props.setSessions(await api.listSessions());
    return { id: session.id, existed: false };
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
    setInput("");
    setStreaming("");
    setThinking("");
    setModelOutput("");
    setCurrentStep(null);
    setPlan([]);
    setToolTrail([]);
    setGenMode(null);
    generationEpochRef.current += 1;
    const epoch = generationEpochRef.current;
    props.setBusy(true);
    props.setError(null);
    try {
      const { id: sessionId, existed } = await ensureSessionId();
      if (generationEpochRef.current !== epoch) return;
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

      const session = props.sessions.find((s) => s.id === sessionId);
      // Fire-and-forget: lifecycle via generation events (started/done/error).
      await api.sendMessage({
        sessionId,
        content: text,
        useAgent: session?.toolsEnabled === true ? true : undefined,
      });
    } catch (e) {
      if (generationEpochRef.current !== epoch) return;
      streamSessionRef.current = null;
      props.setError(e instanceof Error ? e.message : String(e));
      props.setBusy(false);
    }
  }

  async function onStop(): Promise<void> {
    // Invalidate late tokens immediately; stay busy until cancelled/done if possible.
    generationEpochRef.current += 1;
    streamSessionRef.current = null;
    setStreaming("");
    setThinking("");
    setModelOutput("");
    setCurrentStep(null);
    try {
      await api.stopGeneration();
    } finally {
      props.setBusy(false);
      setGenMode(null);
      setPlan([]);
      setToolTrail([]);
      if (props.activeSessionId) {
        props.setMessages(await api.getMessages(props.activeSessionId));
      }
    }
  }

  async function onDeleteSession(id: string): Promise<void> {
    try {
      if (props.busy && (streamSessionRef.current === id || props.activeSessionId === id)) {
        generationEpochRef.current += 1;
        streamSessionRef.current = null;
        await api.stopGeneration();
        props.setBusy(false);
      }
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

  const showProcess =
    props.busy ||
    Boolean(
      streaming ||
        thinking ||
        modelOutput ||
        plan.length ||
        toolTrail.length ||
        props.pendingConfirmSummary,
    );
  const isEmpty = props.messages.length === 0 && !showProcess;

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
        <div className="session-list-head">
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
            className="input"
            value={folderFilter}
            onChange={(e) => setFolderFilter(e.target.value)}
            aria-label="Фильтр папки"
          >
            <option value="">Все папки</option>
            {folders.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        )}
        <div className="session-scroll">
          {filteredSessions.map((s) => (
            <div
              key={s.id}
              className={`session-item ${s.id === props.activeSessionId ? "active" : ""}`}
              onClick={() => props.setActiveSessionId(s.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  props.setActiveSessionId(s.id);
                }
              }}
              role="button"
              tabIndex={0}
            >
              <div className="session-avatar" aria-hidden="true">
                {sessionInitial(s.title)}
              </div>
              <div className="session-meta">
                <div className="session-title">{s.title}</div>
                <div className="muted session-sub">
                  {s.folder ? `${s.folder} · ` : ""}
                  {new Date(s.updatedAt).toLocaleString()}
                </div>
              </div>
              <button
                type="button"
                className="btn ghost session-del"
                title="Удалить"
                aria-label={`Удалить диалог ${s.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  void onDeleteSession(s.id);
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="panel-main chat-main">
        <div className="chat-scroll">
          <div className="chat-inner">
            {activeSession && (
              <div className="chat-session-bar row">
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => setShowParams((v) => !v)}
                >
                  Параметры
                </button>
                <input
                  className="input"
                  style={{ maxWidth: 180 }}
                  placeholder="Папка…"
                  value={activeSession.folder || ""}
                  onChange={(e) => {
                    const value = e.target.value;
                    if (folderTimer.current) clearTimeout(folderTimer.current);
                    folderTimer.current = setTimeout(() => {
                      void setSessionFolder(value);
                    }, 350);
                  }}
                />
                <button type="button" className="btn ghost" onClick={() => void exportActive()}>
                  Экспорт
                </button>
                {props.busy ? (
                  <button type="button" className="btn danger" onClick={() => void onStop()}>
                    Стоп
                  </button>
                ) : canResumeAgent(activeSession, props.messages) ? (
                  <button
                    type="button"
                    className="btn ghost"
                    title="Продолжить агента без полного перепланирования"
                    onClick={() => void onSend(resumePromptFor(activeSession))}
                  >
                    Продолжить
                  </button>
                ) : null}
              </div>
            )}

            {showParams && activeSession && (
              <div className="card">
                <div className="row">
                  {(
                    [
                      ["temperature", activeSession.params.temperature],
                      ["topP", activeSession.params.topP],
                      ["maxTokens", activeSession.params.maxTokens],
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
                <p className="muted" style={{ marginTop: 10, fontSize: "0.8rem" }}>
                  {props.runtime?.loadedModelId &&
                  props.runtime.loadedContext != null &&
                  props.runtime.loadedGpuLayers != null ? (
                    <>
                      Загружено в память: ctx={props.runtime.loadedContext}, ngl=
                      {props.runtime.loadedGpuLayers}. Контекст и GPU-слои меняются во вкладке
                      «Модели» (нужна перезагрузка модели).
                    </>
                  ) : (
                    <>
                      Контекст и GPU-слои задаются при загрузке модели во вкладке «Модели», не в
                      чате.
                    </>
                  )}{" "}
                  {props.onOpenModels ? (
                    <button
                      type="button"
                      className="btn ghost"
                      style={{ padding: "0 6px", fontSize: "0.8rem" }}
                      onClick={() => props.onOpenModels?.()}
                    >
                      Открыть Модели
                    </button>
                  ) : null}
                </p>
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

            <div className="messages">
              {isEmpty && (
                <div className="empty-chat">
                  <div className="empty-chat-brand">
                    Kovi<span>AI</span>soft
                  </div>
                  <p className="muted">
                    Загрузите модель во вкладке «Модели», затем спросите что угодно или попросите
                    сделать задачу с файлами. Процесс ответа будет виден здесь.
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
              {showProcess ? (
                <ProcessTimeline
                  active={props.busy}
                  mode={genMode}
                  thinking={thinking}
                  streaming={streaming}
                  modelOutput={modelOutput}
                  currentStep={currentStep}
                  plan={plan}
                  tools={toolTrail}
                  confirmSummary={props.pendingConfirmSummary}
                />
              ) : null}
              <div ref={messagesEndRef} />
            </div>
          </div>
        </div>

        <div className="composer-dock">
          <div className="composer">
            <div className="composer-toolbar">
              <span className="muted composer-hint">
                Один чат: ответы и действия. @ — файлы / @codebase / @agent. Enter — отправить,
                Shift+Enter — новая строка.
              </span>
            </div>
            <div className="composer-input-wrap">
              {mentionOpen && mentionQueryAt(input, composerCaret) ? (
                <MentionPicker
                  value={input}
                  caret={composerCaret}
                  files={mentionFiles}
                  highlight={mentionHi}
                  disabled={props.busy}
                  onHighlightChange={setMentionHi}
                  onClose={() => setMentionOpen(false)}
                  onPick={(next, nextCaret) => {
                    setInput(next);
                    setComposerCaret(nextCaret);
                    setMentionOpen(false);
                    requestAnimationFrame(() => {
                      const el = composerRef.current;
                      if (!el) return;
                      el.focus();
                      el.setSelectionRange(nextCaret, nextCaret);
                    });
                  }}
                />
              ) : null}
              <textarea
                ref={composerRef}
                className="textarea composer-input"
                value={input}
                placeholder="Спросите… или @файл / @codebase / @agent …"
                onChange={(e) => {
                  setInput(e.target.value);
                  setComposerCaret(e.target.selectionStart);
                  setMentionOpen(true);
                  setMentionHi(0);
                }}
                onClick={(e) => setComposerCaret((e.target as HTMLTextAreaElement).selectionStart)}
                onKeyUp={(e) => setComposerCaret((e.target as HTMLTextAreaElement).selectionStart)}
                onKeyDown={(e) => {
                  const mq = mentionOpen ? mentionQueryAt(input, composerCaret) : null;
                  const items = mq ? buildMentionItems(mq.query, mentionFiles) : [];
                  if (mq && items.length) {
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setMentionHi((h) => Math.min(items.length - 1, h + 1));
                      return;
                    }
                    if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setMentionHi((h) => Math.max(0, h - 1));
                      return;
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setMentionOpen(false);
                      return;
                    }
                    if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
                      e.preventDefault();
                      const picked = applyMention(input, composerCaret, items[mentionHi] || items[0]!);
                      if (picked) {
                        setInput(picked.next);
                        setComposerCaret(picked.nextCaret);
                        setMentionOpen(false);
                        requestAnimationFrame(() => {
                          const el = composerRef.current;
                          if (!el) return;
                          el.focus();
                          el.setSelectionRange(picked.nextCaret, picked.nextCaret);
                        });
                      }
                      return;
                    }
                  }
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void onSend();
                  }
                }}
              />
            </div>
            <div className="composer-actions">
              <button
                className="btn ghost"
                type="button"
                disabled={props.busy}
                title="Вставить @"
                onClick={() => {
                  setInput((v) => `${v}${v.endsWith(" ") || !v ? "" : " "}@`);
                  setMentionOpen(true);
                  requestAnimationFrame(() => {
                    const el = composerRef.current;
                    if (!el) return;
                    el.focus();
                    const c = el.value.length;
                    el.setSelectionRange(c, c);
                    setComposerCaret(c);
                  });
                }}
              >
                @
              </button>
              <button
                className="btn ghost"
                type="button"
                disabled={props.busy}
                title="Вставить @codebase"
                onClick={() =>
                  setInput((v) => (v.includes("@codebase") ? v : `@codebase ${v}`.trim()))
                }
              >
                @codebase
              </button>
              {!props.busy && canResumeAgent(activeSession, props.messages) ? (
                <button
                  className="btn ghost"
                  type="button"
                  title="Продолжить агента"
                  onClick={() => void onSend(resumePromptFor(activeSession))}
                >
                  Продолжить
                </button>
              ) : null}
              <button
                className="btn primary"
                type="button"
                disabled={props.busy || !input.trim()}
                onClick={() => void onSend()}
              >
                Отправить
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

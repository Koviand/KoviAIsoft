import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AppSettings,
  AppView,
  ChatMessage,
  ChatSession,
  LocalModel,
  RuntimeStatus,
  StatusBarInfo,
  SystemInfo,
  ThemePreset,
} from "@kovi/shared";
import { api } from "../api";

function normalizeView(view: string): AppView {
  if (view === "agent") return "chat";
  if (
    view === "chat" ||
    view === "models" ||
    view === "runtime" ||
    view === "mcp" ||
    view === "settings"
  ) {
    return view;
  }
  return "chat";
}

export function useAppState() {
  const [view, setViewRaw] = useState<AppView>("chat");
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [models, setModels] = useState<LocalModel[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<StatusBarInfo | null>(null);
  /** Only chat/agent generation — not Models/Runtime page work. */
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);
  const activeSessionRef = useRef<string | null>(null);
  const viewRef = useRef<AppView>(view);

  activeSessionRef.current = activeSessionId;
  viewRef.current = view;

  const setView = useCallback((v: AppView | string) => {
    setViewRaw(normalizeView(v));
  }, []);

  const refresh = useCallback(async () => {
    const [s, sys, rt, mods, sess, bar] = await Promise.all([
      api.getSettings(),
      api.getSystemInfo(),
      api.getRuntimeStatus(),
      api.listModels(),
      api.listSessions(),
      api.getStatusBar(),
    ]);
    setSettings(s);
    setSystem(sys);
    setRuntime(rt);
    setModels(mods);
    setSessions(sess);
    setStatus({ ...bar, view: viewRef.current });
    if (!activeSessionRef.current && sess[0]) {
      setActiveSessionId(sess[0].id);
    }
  }, []);

  useEffect(() => {
    refresh()
      .catch((e) => setError(String(e)))
      .finally(() => setBooting(false));
  }, [refresh]);

  useEffect(() => {
    const t = setInterval(() => {
      api.getRuntimeStatus().then(setRuntime).catch(() => undefined);
      api
        .getStatusBar()
        .then((bar) => setStatus({ ...bar, view: viewRef.current }))
        .catch(() => undefined);
    }, 3000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    setStatus((prev) => (prev ? { ...prev, view } : prev));
  }, [view]);

  // Keep generating flag correct even if user leaves Chat page mid-agent.
  useEffect(() => {
    const off = api.onAgentEvent((p) => {
      const ev = p.event;
      if (ev.type === "done" || ev.type === "cancelled" || ev.type === "error") {
        setGenerating(false);
        if (ev.type === "error") setError(ev.message);
        if (activeSessionRef.current === p.sessionId) {
          void api.getMessages(p.sessionId).then(setMessages).catch(() => undefined);
        }
        void api.listSessions().then(setSessions).catch(() => undefined);
        void api
          .getStatusBar()
          .then((bar) => setStatus({ ...bar, view: viewRef.current }))
          .catch(() => undefined);
      }
    });
    return off;
  }, []);

  useEffect(() => {
    if (!activeSessionId) {
      setMessages([]);
      return;
    }
    // Clear immediately so we never flash another session's history.
    setMessages([]);
    let cancelled = false;
    const sid = activeSessionId;
    api
      .getMessages(sid)
      .then((msgs) => {
        if (cancelled || activeSessionRef.current !== sid) return;
        setMessages((current) => {
          // Keep optimistic tmp user bubble if server still has an empty new session.
          const hasTmp = current.some((m) => m.id.startsWith("tmp-"));
          if (hasTmp && msgs.length === 0) return current;
          return msgs;
        });
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [activeSessionId]);

  useEffect(() => {
    if (!settings) return;
    applyTheme(settings.themePreset, settings.themeCustom);
  }, [settings]);

  return {
    view,
    setView,
    settings,
    setSettings,
    system,
    runtime,
    models,
    setModels,
    sessions,
    setSessions,
    activeSessionId,
    setActiveSessionId,
    messages,
    setMessages,
    status,
    generating,
    setGenerating,
    /** @deprecated alias — chat generation only */
    busy: generating,
    setBusy: setGenerating,
    error,
    setError,
    booting,
    refresh,
  };
}

export function applyTheme(
  preset: ThemePreset,
  custom: AppSettings["themeCustom"],
): void {
  const root = document.documentElement;
  if (preset === "custom") {
    root.dataset.theme = "dark";
    root.style.setProperty("--bg", custom.background);
    root.style.setProperty("--surface", custom.surface);
    root.style.setProperty("--text", custom.text);
    root.style.setProperty("--accent", custom.accent);
    root.style.setProperty("--radius", `${custom.radius}px`);
  } else {
    root.dataset.theme = preset;
    root.style.removeProperty("--bg");
    root.style.removeProperty("--surface");
    root.style.removeProperty("--text");
    root.style.removeProperty("--accent");
    root.style.removeProperty("--radius");
  }
}

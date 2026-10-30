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
import type { AgentChangeItem } from "../components/AgentChangesPanel";

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
  const [pendingConfirm, setPendingConfirm] = useState<{
    id: string;
    sessionId: string;
    summary: string;
    risk: string;
    diff?: string;
  } | null>(null);
  const [agentChanges, setAgentChanges] = useState<AgentChangeItem[]>([]);
  const [selectedChangeId, setSelectedChangeId] = useState<string | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
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

  // Keep generating / confirmations correct even if user leaves Chat mid-agent.
  useEffect(() => {
    const off = api.onAgentEvent((p) => {
      const ev = p.event;
      if (ev.type === "started") {
        setGenerating(true);
        setAgentChanges([]);
        setSelectedChangeId(null);
        void api
          .getStatusBar()
          .then((bar) => setStatus({ ...bar, view: viewRef.current }))
          .catch(() => undefined);
      }
      if (ev.type === "confirmation_required") {
        setPendingConfirm({
          id: ev.confirmation.id,
          sessionId: p.sessionId,
          summary: ev.confirmation.summary,
          risk: ev.confirmation.risk,
          diff: ev.confirmation.diff,
        });
        const pathGuess =
          typeof ev.confirmation.args.path === "string"
            ? ev.confirmation.args.path
            : ev.confirmation.toolName;
        const change: AgentChangeItem = {
          id: ev.confirmation.id,
          path: pathGuess,
          summary: ev.confirmation.summary,
          diff: ev.confirmation.diff,
          confirmationId: ev.confirmation.id,
          status: "pending",
        };
        setAgentChanges((cur) => {
          const without = cur.filter((c) => c.confirmationId !== change.confirmationId);
          return [...without, change];
        });
        setSelectedChangeId(change.id);
        setConfirmBusy(false);
        setActiveSessionId(p.sessionId);
        setViewRaw("chat");
        setGenerating(true);
      }
      if (ev.type === "tool_call" && (ev.name === "write_file" || ev.name === "apply_patch")) {
        const pathGuess = typeof ev.args.path === "string" ? ev.args.path : ev.name;
        setAgentChanges((cur) => {
          if (cur.some((c) => c.path === pathGuess && c.status === "pending")) return cur;
          if (cur.some((c) => c.path === pathGuess && c.status === "applied")) {
            return cur.map((c) =>
              c.path === pathGuess ? { ...c, summary: `${ev.name}…`, status: "applied" } : c,
            );
          }
          const item: AgentChangeItem = {
            id: ev.callId,
            path: pathGuess,
            summary: ev.name,
            status: "applied",
          };
          return [...cur.filter((c) => c.path !== pathGuess), item];
        });
      }
      if (ev.type === "confirmation_timeout") {
        setPendingConfirm((cur) => (cur?.id === ev.confirmationId ? null : cur));
        setConfirmBusy(false);
        setError(
          `Подтверждение «${ev.toolName}» истекло (120 с) — действие отклонено`,
        );
      }
      if (ev.type === "step_start" || ev.type === "tool_call" || ev.type === "plan") {
        setGenerating(true);
        void api
          .getStatusBar()
          .then((bar) => setStatus({ ...bar, view: viewRef.current }))
          .catch(() => undefined);
      }
      if (ev.type === "done" || ev.type === "cancelled" || ev.type === "error") {
        setGenerating(false);
        setPendingConfirm(null);
        setConfirmBusy(false);
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

  const resolvePendingConfirm = useCallback(
    async (approved: boolean, remember = false) => {
      if (!pendingConfirm || confirmBusy) return;
      setConfirmBusy(true);
      try {
        await api.resolveConfirmation({
          confirmationId: pendingConfirm.id,
          approved,
          rememberForSession: remember,
        });
        setAgentChanges((cur) =>
          cur.map((c) =>
            c.confirmationId === pendingConfirm.id
              ? { ...c, status: approved ? "accepted" : "rejected" }
              : c,
          ),
        );
        setPendingConfirm(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setConfirmBusy(false);
      }
    },
    [pendingConfirm, confirmBusy],
  );

  const resolveChangeItem = useCallback(
    async (item: AgentChangeItem, approved: boolean) => {
      if (!item.confirmationId || confirmBusy) return;
      setConfirmBusy(true);
      try {
        await api.resolveConfirmation({
          confirmationId: item.confirmationId,
          approved,
          rememberForSession: false,
        });
        setAgentChanges((cur) =>
          cur.map((c) =>
            c.id === item.id ? { ...c, status: approved ? "accepted" : "rejected" } : c,
          ),
        );
        setPendingConfirm((cur) => (cur?.id === item.confirmationId ? null : cur));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setConfirmBusy(false);
      }
    },
    [confirmBusy],
  );

  useEffect(() => {
    if (!activeSessionId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    const sid = activeSessionId;
    // Don't wipe optimistic tmp bubbles (new session mid-send). Otherwise clear to avoid
    // flashing the previous session while the next history loads.
    setMessages((current) =>
      current.some((m) => m.id.startsWith("tmp-")) ? current : [],
    );
    api
      .getMessages(sid)
      .then((msgs) => {
        if (cancelled || activeSessionRef.current !== sid) return;
        setMessages((current) => {
          const hasTmp = current.some((m) => m.id.startsWith("tmp-"));
          // Keep optimistic bubble until the server has persisted the user message.
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
    pendingConfirm,
    agentChanges,
    selectedChangeId,
    setSelectedChangeId,
    clearAgentChanges: () => {
      setAgentChanges([]);
      setSelectedChangeId(null);
    },
    confirmBusy,
    resolvePendingConfirm,
    resolveChangeItem,
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
    root.dataset.theme = "light";
    root.style.setProperty("--bg", custom.background);
    root.style.setProperty("--surface", custom.surface);
    root.style.setProperty("--text", custom.text);
    root.style.setProperty("--ink", custom.text);
    root.style.setProperty("--accent", custom.accent);
    root.style.setProperty("--accent-2", custom.accent);
    root.style.setProperty("--radius", `${custom.radius}px`);
  } else {
    root.dataset.theme = preset;
    root.style.removeProperty("--bg");
    root.style.removeProperty("--surface");
    root.style.removeProperty("--text");
    root.style.removeProperty("--ink");
    root.style.removeProperty("--accent");
    root.style.removeProperty("--accent-2");
    root.style.removeProperty("--radius");
  }
}

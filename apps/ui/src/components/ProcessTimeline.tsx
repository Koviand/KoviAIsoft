import { useEffect, useRef, useState } from "react";
import type { AgentPlanStep } from "@kovi/shared";
import { statusRu } from "../lib/labels";

export type ProcessToolItem = {
  callId: string;
  name: string;
  status: "running" | "done" | "error";
  detail?: string;
  argsPreview?: string;
};

export type ProcessMode = "chat" | "agent" | null;

export function ProcessTimeline(props: {
  active: boolean;
  mode: ProcessMode;
  thinking: string;
  streaming: string;
  /** Live raw tokens while the model generates an agent JSON step. */
  modelOutput?: string;
  currentStep?: string | null;
  plan: AgentPlanStep[];
  tools: ProcessToolItem[];
  confirmSummary?: string | null;
}) {
  const [thinkingOpen, setThinkingOpen] = useState(true);
  const [draftOpen, setDraftOpen] = useState(true);
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({});
  const draftEndRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (props.active && props.modelOutput) {
      draftEndRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [props.modelOutput, props.active]);

  if (
    !props.active &&
    !props.thinking &&
    !props.streaming &&
    !props.modelOutput &&
    !props.plan.length &&
    !props.tools.length &&
    !props.confirmSummary
  ) {
    return null;
  }

  const modeLabel =
    props.mode === "agent"
      ? props.currentStep
        ? `Агент · ${props.currentStep}`
        : "Агент работает…"
      : props.mode === "chat"
        ? "Модель отвечает…"
        : "Генерация…";

  const ctxMatch = props.thinking?.match(/контекст\s*~?\s*(\d+)\s*\/\s*(\d+)\s*tok/i);
  const condensed = /сжат(ие|ая)\s+истори/i.test(props.thinking || "");

  return (
    <div className="process-timeline msg assistant msg-enter" aria-live="polite">
      <div className="role">Процесс</div>
      <div className="process-timeline-body">
        {props.active && (
          <div className="process-status">
            <span className="gen-dots" aria-hidden="true" />
            <span>{modeLabel}</span>
            {ctxMatch ? (
              <span className="muted mono" style={{ marginLeft: 8, fontSize: "0.75rem" }}>
                ctx {ctxMatch[1]}/{ctxMatch[2]}
                {condensed ? " · сжатие" : ""}
              </span>
            ) : condensed ? (
              <span className="muted" style={{ marginLeft: 8, fontSize: "0.75rem" }}>
                сжатие истории
              </span>
            ) : null}
          </div>
        )}

        {props.thinking ? (
          <div className="process-block thinking">
            <button
              type="button"
              className="process-toggle"
              aria-expanded={thinkingOpen}
              onClick={() => setThinkingOpen((v) => !v)}
            >
              <span className="thinking-label">Статус / размышление</span>
              <span className="muted">{thinkingOpen ? "▾" : "▸"}</span>
            </button>
            {thinkingOpen ? (
              <div className="process-thinking-text">
                {props.thinking}
                {props.active && !props.streaming && !props.modelOutput ? (
                  <span className="caret" aria-hidden="true" />
                ) : null}
              </div>
            ) : null}
          </div>
        ) : props.active ? (
          <div className="process-block thinking">
            <div className="process-thinking-text muted">
              Ожидание ответа модели…
              <span className="caret" aria-hidden="true" />
            </div>
          </div>
        ) : null}

        {props.modelOutput ? (
          <div className="process-block process-draft">
            <button
              type="button"
              className="process-toggle"
              aria-expanded={draftOpen}
              onClick={() => setDraftOpen((v) => !v)}
            >
              <span className="thinking-label">Вывод модели</span>
              <span className="muted">
                {props.modelOutput.length.toLocaleString("ru-RU")} симв.{" "}
                {draftOpen ? "▾" : "▸"}
              </span>
            </button>
            {draftOpen ? (
              <pre className="process-draft-text" ref={draftEndRef}>
                {props.modelOutput}
                {props.active ? <span className="caret" aria-hidden="true" /> : null}
              </pre>
            ) : null}
          </div>
        ) : null}

        {props.plan.length > 0 ? (
          <div className="process-block plan-list">
            <strong>План · чеклист</strong>
            {props.plan.map((p) => (
              <div key={p.id} className={`plan-item status-${p.status}`}>
                <span className="plan-status">{statusRu(p.status)}</span>
                <span>
                  <span className="muted mono" style={{ marginRight: 6 }}>
                    {p.id}.
                  </span>
                  {p.title}
                </span>
                {p.detail ? <span className="muted process-detail">{p.detail}</span> : null}
              </div>
            ))}
          </div>
        ) : null}

        {props.tools.length > 0 ? (
          <div className="process-block tool-trail">
            <strong>Инструменты</strong>
            {props.tools.map((t) => {
              const open = expandedTools[t.callId];
              return (
                <div key={t.callId} className={`tool-chip status-${t.status}`}>
                  <button
                    type="button"
                    className="process-tool-head"
                    onClick={() =>
                      setExpandedTools((prev) => ({ ...prev, [t.callId]: !prev[t.callId] }))
                    }
                  >
                    <span className="mono">{t.name}</span>
                    <span className="muted">{statusRu(t.status)}</span>
                  </button>
                  {t.argsPreview ? (
                    <div className="muted process-args">{t.argsPreview}</div>
                  ) : null}
                  {open && t.detail ? (
                    <pre className="process-tool-detail">{t.detail}</pre>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}

        {props.confirmSummary ? (
          <div className="process-block process-confirm">
            <strong>Нужно подтверждение</strong>
            <div className="muted">{props.confirmSummary}</div>
          </div>
        ) : null}

        {props.streaming ? (
          <div className="process-block process-stream">
            <div className="thinking-label">Ответ</div>
            <div className="msg-body">
              {props.streaming}
              {props.active ? <span className="caret" aria-hidden="true" /> : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

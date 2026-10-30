export type AgentChangeItem = {
  id: string;
  path: string;
  summary: string;
  diff?: string;
  confirmationId?: string;
  status: "pending" | "accepted" | "rejected" | "applied";
};

type Props = {
  items: AgentChangeItem[];
  confirmBusy?: boolean;
  onAccept: (item: AgentChangeItem) => void;
  onReject: (item: AgentChangeItem) => void;
  onDismiss: () => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
};

export function AgentChangesPanel(props: Props) {
  if (!props.items.length) return null;
  const selected =
    props.items.find((i) => i.id === props.selectedId) || props.items[props.items.length - 1]!;

  return (
    <div className="agent-changes-panel" role="region" aria-label="Изменения агента">
      <div className="agent-changes-head row">
        <strong>Изменения агента</strong>
        <button type="button" className="btn ghost" onClick={props.onDismiss}>
          Скрыть
        </button>
      </div>
      <div className="agent-changes-list">
        {props.items.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`agent-change-item${item.id === selected.id ? " active" : ""}`}
            onClick={() => props.onSelect(item.id)}
          >
            <span className="mono">{item.path}</span>
            <span className="muted">{statusRu(item.status)}</span>
          </button>
        ))}
      </div>
      {selected.diff ? <pre className="diff-preview">{selected.diff}</pre> : (
        <p className="muted" style={{ fontSize: "0.85rem" }}>
          {selected.summary}
        </p>
      )}
      {selected.status === "pending" && selected.confirmationId ? (
        <div className="row" style={{ marginTop: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            className="btn primary"
            disabled={props.confirmBusy}
            onClick={() => props.onAccept(selected)}
          >
            Принять
          </button>
          <button
            type="button"
            className="btn danger"
            disabled={props.confirmBusy}
            onClick={() => props.onReject(selected)}
          >
            Отклонить
          </button>
        </div>
      ) : null}
    </div>
  );
}

function statusRu(s: AgentChangeItem["status"]): string {
  if (s === "pending") return "ожидает";
  if (s === "accepted") return "принято";
  if (s === "rejected") return "отклонено";
  return "записано";
}

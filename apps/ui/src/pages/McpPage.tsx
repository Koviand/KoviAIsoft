import { useState } from "react";
import type { AppSettings, McpServerConfig } from "@kovi/shared";
import { api } from "../api";

function splitArgs(raw: string): string[] {
  // Keep quoted segments so paths with spaces survive.
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    out.push(m[1] ?? m[2] ?? m[3]);
  }
  return out.filter(Boolean);
}

export function McpPage(props: {
  settings: AppSettings | null;
  setSettings: (s: AppSettings) => void;
  setError: (e: string | null) => void;
}) {
  const [name, setName] = useState("filesystem");
  const [command, setCommand] = useState("npx");
  const [args, setArgs] = useState(
    '-y @modelcontextprotocol/server-filesystem "C:\\Models\\LFM"',
  );
  const [saving, setSaving] = useState(false);

  if (!props.settings) return <div className="stack-page">Загрузка…</div>;

  async function save(next: AppSettings): Promise<void> {
    setSaving(true);
    try {
      const saved = await api.saveSettings(next);
      props.setSettings(saved);
    } catch (e) {
      props.setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  function addServer(): void {
    if (!name.trim() || !command.trim()) {
      props.setError("Укажите имя и команду MCP-сервера");
      return;
    }
    const cfg: McpServerConfig = {
      id: `mcp_${Date.now()}`,
      name: name.trim(),
      enabled: true,
      transport: "stdio",
      command: command.trim(),
      args: splitArgs(args),
    };
    void save({
      ...props.settings!,
      mcpServers: [...props.settings!.mcpServers, cfg],
    });
  }

  return (
    <div className="stack-page">
      <header className="page-header">
        <h1 className="h1">MCP-серверы</h1>
        <p className="muted page-sub">
          Внешние инструменты для режима «Агент» (stdio). Включаются только при работе агента.
        </p>
      </header>

      <section className="card elevated">
        <h3>Добавить сервер</h3>
        <div className="grid-2" style={{ marginTop: 12 }}>
          <label>
            Имя
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="filesystem"
            />
          </label>
          <label>
            Команда
            <input
              className="input"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="npx"
            />
          </label>
          <label className="full">
            Аргументы (пути с пробелами — в кавычках)
            <input
              className="input"
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder='-y @modelcontextprotocol/server-filesystem "C:\\path"'
            />
          </label>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn primary" type="button" disabled={saving} onClick={addServer}>
            Добавить
          </button>
        </div>
      </section>

      {props.settings.mcpServers.length === 0 && (
        <div className="muted">Пока нет MCP-серверов. Без них агент использует встроенные инструменты.</div>
      )}

      {props.settings.mcpServers.map((s) => (
        <div key={s.id} className="card">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div>
              <strong>{s.name}</strong>
              <div className="muted mono" style={{ fontSize: "0.8rem", marginTop: 4 }}>
                {s.transport} · {s.command} {(s.args || []).join(" ")}
              </div>
            </div>
            <div className="row">
              <label className="row">
                <input
                  type="checkbox"
                  checked={s.enabled}
                  disabled={saving}
                  onChange={(e) => {
                    const mcpServers = props.settings!.mcpServers.map((x) =>
                      x.id === s.id ? { ...x, enabled: e.target.checked } : x,
                    );
                    void save({ ...props.settings!, mcpServers });
                  }}
                />
                Включён
              </label>
              <button
                className="btn danger"
                type="button"
                disabled={saving}
                onClick={() =>
                  void save({
                    ...props.settings!,
                    mcpServers: props.settings!.mcpServers.filter((x) => x.id !== s.id),
                  })
                }
              >
                Удалить
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

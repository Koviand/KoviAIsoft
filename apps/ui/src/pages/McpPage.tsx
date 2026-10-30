import { useState } from "react";
import type { AppSettings, McpHealthResult, McpServerConfig } from "@kovi/shared";
import { MCP_PRESETS } from "@kovi/shared";
import { api } from "../api";
import { PageShell, SettingsSection } from "../components/PageShell";

function splitArgs(raw: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    out.push(m[1] ?? m[2] ?? m[3]);
  }
  return out.filter(Boolean);
}

const MCP_NAV = [
  { id: "presets", label: "Пресеты", group: "Добавить" },
  { id: "add-server", label: "Вручную", group: "Добавить" },
  { id: "servers", label: "Список", group: "Управление" },
] as const;

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
  const [health, setHealth] = useState<McpHealthResult[]>([]);

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

  function addPreset(preset: (typeof MCP_PRESETS)[number]): void {
    if (props.settings!.mcpServers.some((s) => s.id === preset.id || s.name === preset.name)) {
      props.setError(`Сервер «${preset.name}» уже добавлен`);
      return;
    }
    const cfg: McpServerConfig = {
      id: preset.id,
      name: preset.name,
      enabled: true,
      transport: preset.transport,
      command: preset.command,
      args: [...(preset.args || [])],
      url: preset.url,
      env: preset.env,
    };
    void save({
      ...props.settings!,
      mcpServers: [...props.settings!.mcpServers, cfg],
    });
  }

  async function runHealth(server?: McpServerConfig): Promise<void> {
    setSaving(true);
    try {
      const results = await api.checkMcpHealth(server);
      setHealth(results);
    } catch (e) {
      props.setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <PageShell
      title="MCP-серверы"
      subtitle="Внешние инструменты для режима «Агент». Пресеты и проверка «жив/не жив»."
      actions={
        <button className="btn" type="button" disabled={saving} onClick={() => void runHealth()}>
          Проверить все
        </button>
      }
      nav={[...MCP_NAV]}
    >
      <SettingsSection
        id="presets"
        title="Пресеты"
        description="Готовые серверы — добавьте в один клик."
        elevated
      >
        <div className="option-grid">
          {MCP_PRESETS.map((p) => (
            <div key={p.id} className="option-card">
              <div className="option-card-title">{p.name}</div>
              <div className="muted" style={{ fontSize: "0.8rem" }}>
                {p.blurb}
              </div>
              <div className="toolbar-row">
                <button className="btn" type="button" disabled={saving} onClick={() => addPreset(p)}>
                  Добавить
                </button>
              </div>
            </div>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection id="add-server" title="Добавить сервер вручную" elevated>
        <div className="grid-2">
          <label className="field">
            <span className="field-label">Имя</span>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="filesystem"
            />
          </label>
          <label className="field">
            <span className="field-label">Команда</span>
            <input
              className="input"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="npx"
            />
          </label>
          <label className="field full">
            <span className="field-label">Аргументы</span>
            <input
              className="input"
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder='-y @modelcontextprotocol/server-filesystem "C:\\path"'
            />
            <p className="field-hint">Пути с пробелами — в кавычках</p>
          </label>
        </div>
        <div className="toolbar-row">
          <button className="btn primary" type="button" disabled={saving} onClick={addServer}>
            Добавить
          </button>
        </div>
      </SettingsSection>

      {health.length > 0 && (
        <SettingsSection id="health" title="Статус проверки">
          {health.map((h) => (
            <div key={h.serverId} className="status-strip" style={{ justifyContent: "space-between" }}>
              <span>
                <strong>{h.name}</strong>{" "}
                <span className={h.ok ? "badge" : "badge badge-danger"}>
                  {h.ok ? "OK" : "ошибка"}
                </span>
              </span>
              <span className="muted mono" style={{ fontSize: "0.78rem" }}>
                {h.message}
              </span>
            </div>
          ))}
        </SettingsSection>
      )}

      <SettingsSection
        id="servers"
        title="Подключённые серверы"
        description={
          props.settings.mcpServers.length === 0
            ? "Пока нет MCP-серверов. Без них агент использует встроенные инструменты."
            : undefined
        }
      >
        {props.settings.mcpServers.map((s) => (
          <div key={s.id} className="option-card">
            <div className="row" style={{ justifyContent: "space-between", width: "100%" }}>
              <div style={{ minWidth: 0 }}>
                <div className="option-card-title">{s.name}</div>
                <div className="option-card-meta">
                  {s.transport} · {s.command} {(s.args || []).join(" ")}
                </div>
              </div>
              <div className="toolbar-row">
                <button
                  className="btn ghost"
                  type="button"
                  disabled={saving}
                  onClick={() => void runHealth(s)}
                >
                  Проверить
                </button>
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
      </SettingsSection>
    </PageShell>
  );
}

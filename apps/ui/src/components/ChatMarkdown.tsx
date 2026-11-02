import type { ReactNode } from "react";
import { api } from "../api";

/**
 * Lightweight markdown for chat: fenced code, inline code, bold, links, newlines.
 * Paths open via api.openPath (explorer / default app).
 */
export function ChatMarkdown(props: { text: string; className?: string }) {
  const blocks = splitBlocks(props.text);
  return (
    <div className={props.className || "msg-body msg-md"}>
      {blocks.map((b, i) =>
        b.type === "code" ? (
          <pre key={i} className="msg-code">
            {b.lang ? <span className="msg-code-lang">{b.lang}</span> : null}
            <code>{b.text}</code>
          </pre>
        ) : (
          <p key={i} className="msg-md-p">
            {renderInline(b.text)}
          </p>
        ),
      )}
    </div>
  );
}

type Block = { type: "text"; text: string } | { type: "code"; lang: string; text: string };

function splitBlocks(src: string): Block[] {
  const out: Block[] = [];
  const re = /```([\w.-]*)\n?([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m.index > last) {
      out.push({ type: "text", text: src.slice(last, m.index) });
    }
    out.push({ type: "code", lang: m[1] || "", text: m[2] || "" });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ type: "text", text: src.slice(last) });
  if (!out.length) out.push({ type: "text", text: src });
  return out;
}

function openPath(p: string): void {
  void api.openPath(p).catch(() => undefined);
}

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re =
    /(`[^`]+`|\*\*[^*]+\*\*|\[([^\]]+)\]\(([^)]+)\)|(?:^|[\s(])((?:[A-Za-z]:)?(?:[\\/][\w.\-]+)+\.\w{1,8}|checkpoint:\s*\S+))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const raw = m[0];
    if (raw.startsWith("`")) {
      nodes.push(
        <code key={key++} className="msg-inline-code">
          {raw.slice(1, -1)}
        </code>,
      );
    } else if (raw.startsWith("**")) {
      nodes.push(<strong key={key++}>{raw.slice(2, -2)}</strong>);
    } else if (raw.startsWith("[")) {
      const label = m[2] || raw;
      const href = m[3] || "#";
      nodes.push(
        <a key={key++} href={href} target="_blank" rel="noreferrer">
          {label}
        </a>,
      );
    } else {
      let path = (m[4] || raw).trim();
      if (path.toLowerCase().startsWith("checkpoint:")) {
        path = path.slice("checkpoint:".length).trim();
      }
      const lead = raw.slice(0, raw.length - (m[4] || "").length);
      if (lead) nodes.push(lead);
      nodes.push(
        <button
          key={key++}
          type="button"
          className="msg-path"
          title={`Открыть: ${path}`}
          onClick={() => openPath(path)}
        >
          {path}
        </button>,
      );
    }
    last = m.index + raw.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

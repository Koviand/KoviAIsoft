import { useEffect, useMemo, useState } from "react";
import { api } from "../api";

const SPECIAL = ["@codebase", "@agent"] as const;

type Props = {
  value: string;
  caret: number;
  disabled?: boolean;
  highlight?: number;
  files?: string[];
  onPick: (nextValue: string, nextCaret: number) => void;
  onClose: () => void;
  onHighlightChange?: (index: number) => void;
};

export function mentionQueryAt(
  value: string,
  caret: number,
): { start: number; query: string } | null {
  const before = value.slice(0, caret);
  const m = before.match(/(^|[\s])@([^\s@]*)$/);
  if (!m || m.index == null) return null;
  const at = m.index + (m[1] ? m[1].length : 0);
  return { start: at, query: m[2] || "" };
}

export function buildMentionItems(query: string, files: string[]): string[] {
  const q = query.toLowerCase();
  const specials = SPECIAL.filter((s) => s.slice(1).startsWith(q) || s.includes(q));
  const matched = files
    .filter((f) => !q || f.toLowerCase().includes(q))
    .slice(0, 12)
    .map((f) => `@${f}`);
  return [...specials, ...matched].slice(0, 14);
}

export function applyMention(
  value: string,
  caret: number,
  item: string,
): { next: string; nextCaret: number } | null {
  const active = mentionQueryAt(value, caret);
  if (!active) return null;
  const before = value.slice(0, active.start);
  const after = value.slice(caret);
  const insert = `${item} `;
  const next = `${before}${insert}${after}`;
  return { next, nextCaret: before.length + insert.length };
}

export function MentionPicker(props: Props) {
  const active = mentionQueryAt(props.value, props.caret);
  const [localFiles, setLocalFiles] = useState<string[]>([]);
  const files = props.files ?? localFiles;
  const hi = props.highlight ?? 0;

  useEffect(() => {
    if (props.files || !active || props.disabled) return;
    let cancelled = false;
    void api
      .listProjectMentions()
      .then((r) => {
        if (!cancelled) setLocalFiles(r.files);
      })
      .catch(() => {
        if (!cancelled) setLocalFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [Boolean(active), props.disabled, props.files]);

  const items = useMemo(() => {
    if (!active) return [] as string[];
    return buildMentionItems(active.query, files);
  }, [active, files]);

  if (!active || props.disabled || items.length === 0) return null;

  function apply(item: string): void {
    const r = applyMention(props.value, props.caret, item);
    if (!r) return;
    props.onPick(r.next, r.nextCaret);
    props.onClose();
  }

  return (
    <div className="mention-picker" role="listbox">
      {items.map((item, i) => (
        <button
          key={item}
          type="button"
          role="option"
          aria-selected={i === hi}
          className={`mention-item${i === hi ? " active" : ""}`}
          onMouseEnter={() => props.onHighlightChange?.(i)}
          onMouseDown={(e) => {
            e.preventDefault();
            apply(item);
          }}
        >
          {item}
        </button>
      ))}
    </div>
  );
}

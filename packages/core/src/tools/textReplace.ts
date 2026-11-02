export type TextReplaceHunk = { oldText: string; newText: string };

/** Literal replace (no $& / $$ interpretation) with CRLF/LF tolerance. */
export function applyTextReplace(current: string, oldText: string, newText: string): string {
  if (!oldText) {
    throw new Error("oldText пустой — укажите фрагмент для замены");
  }
  const tryOnce = (hay: string, needle: string, repl: string): string | null => {
    const count = hay.split(needle).length - 1;
    if (count === 0) return null;
    if (count > 1) {
      throw new Error(`Фрагмент встречается ${count} раз — уточните oldText`);
    }
    return hay.replace(needle, () => repl);
  };

  const direct = tryOnce(current, oldText, newText);
  if (direct != null) return direct;

  // File is CRLF, model sent LF (or vice versa).
  if (current.includes("\r\n") && !oldText.includes("\r\n") && oldText.includes("\n")) {
    const oldCrlf = oldText.replace(/\n/g, "\r\n");
    const newCrlf = newText.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
    const via = tryOnce(current, oldCrlf, newCrlf);
    if (via != null) return via;
  }
  if (!current.includes("\r\n") && oldText.includes("\r\n")) {
    const oldLf = oldText.replace(/\r\n/g, "\n");
    const newLf = newText.replace(/\r\n/g, "\n");
    const via = tryOnce(current, oldLf, newLf);
    if (via != null) return via;
  }

  throw new Error("Фрагмент для замены не найден");
}

/** Apply several search/replace hunks sequentially (multi-hunk patch). */
export function applyTextReplaceHunks(
  current: string,
  hunks: TextReplaceHunk[],
): string {
  if (!hunks.length) {
    throw new Error("apply_patch: пустой список replacements");
  }
  let next = current;
  for (let i = 0; i < hunks.length; i++) {
    const h = hunks[i]!;
    try {
      next = applyTextReplace(next, h.oldText, h.newText);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Хунк ${i + 1}/${hunks.length}: ${msg}`);
    }
  }
  return next;
}

/**
 * Normalize apply_patch args into ordered hunks.
 * Supports `replacements: [{oldText,newText},…]` or classic oldText/newText,
 * and delimiter `<<<HUNK>>>` inside oldText/newText pairs of equal count.
 */
export function normalizePatchHunks(args: {
  oldText?: unknown;
  newText?: unknown;
  replacements?: unknown;
}): TextReplaceHunk[] {
  if (Array.isArray(args.replacements)) {
    const hunks: TextReplaceHunk[] = [];
    for (const raw of args.replacements) {
      if (!raw || typeof raw !== "object") continue;
      const o = raw as Record<string, unknown>;
      const oldText = String(o.oldText ?? o.old ?? "");
      const newText = String(o.newText ?? o.new ?? "");
      if (!oldText) continue;
      hunks.push({ oldText, newText });
    }
    if (hunks.length) return hunks;
  }

  const oldText = typeof args.oldText === "string" ? args.oldText : "";
  const newText = typeof args.newText === "string" ? args.newText : "";
  if (!oldText) return [];

  const sep = "<<<HUNK>>>";
  if (oldText.includes(sep) || newText.includes(sep)) {
    const olds = oldText.split(sep);
    const news = newText.split(sep);
    if (olds.length !== news.length) {
      throw new Error(
        `apply_patch: число hunks в oldText (${olds.length}) ≠ newText (${news.length})`,
      );
    }
    return olds.map((o, i) => ({ oldText: o, newText: news[i] ?? "" }));
  }

  return [{ oldText, newText }];
}

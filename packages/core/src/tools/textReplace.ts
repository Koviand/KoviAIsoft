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

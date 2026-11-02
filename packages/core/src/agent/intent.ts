/**
 * Shared heuristics: when to route to the agent loop and when to force file writes.
 * Keep codingIntent aligned across parseAgentIntent (routing) and wantsFiles (force-write).
 */

/** True when the user is asking to create/edit code or project files. */
export function detectCodingTask(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  // Verb stem + concrete artifact (JS `\b` is ASCII-only — avoid for Cyrillic).
  const ruEn =
    /(напис\p{L}*|напиш\p{L}*|созда\p{L}*|сдела\p{L}*|реализ\p{L}*|постро\p{L}*|исправ\p{L}*|добав\p{L}*|перепиш\p{L}*|рефактор\p{L}*|почин\p{L}*|допил\p{L}*|доработ\p{L}*).{0,100}(игр[уыае]|программ\p{L}*|скрипт\p{L}*|файл\p{L}*|проект\p{L}*|приложени\p{L}*|код\p{L}*|модул\p{L}*|функци\p{L}*|класс\p{L}*|баг\p{L}*|ошибк\p{L}*|auth|tetris|тетрис|\.py|\.ts|\.js|\.tsx|\.html|\.css|\.json)/iu.test(
      trimmed,
    ) ||
    /\b(write|create|implement|build|fix|edit|refactor|rewrite|repair)\b.{0,80}\b(game|app|file|script|python|module|function|bug|auth|tetris|code|\.py|\.ts|\.js|\.tsx|\.html)\b/i.test(
      trimmed,
    );
  if (ruEn) return true;
  // Shorter cues for force-write inside agent loop (need an action verb, not just a language name).
  return (
    /(напиш|создай|сделай|реализ|добав|исправ|почин|перепиш|допил).{0,80}(файл|код|игр[ауые]|тетрис|tetris|скрипт|программ|модул|баг|\.py|\.ts|\.js|\.tsx|\.html)/i.test(
      trimmed,
    ) ||
    /\b(write|create|implement|fix|edit).{0,60}(\.py|\.ts|\.js|\.tsx|file|script|game|tetris)\b/i.test(
      trimmed,
    )
  );
}

/**
 * Short project tasks when projectRoot is set — Cursor-like «сделай tetris» / «почини X»
 * without requiring the word «файл/код» in the same phrase.
 */
export function detectShortProjectTask(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 220) return false;
  // Avoid \\b for Cyrillic (JS word chars are ASCII-only).
  return (
    /^(сделай|создай|напиши|почини|исправь|добавь|реализуй|перепиши|допиши|убери|удали|проверь|запусти)($|[\s:,.!?])/i.test(
      trimmed,
    ) ||
    /^(make|create|write|fix|add|implement|build|remove|delete|check|run)\b/i.test(trimmed)
  );
}

/** Shell / FS / browser actions that need tools even without a coding verb. */
export function detectToolAction(text: string, hasProject: boolean): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const shellOrBrowse =
    /(запуст\p{L}*|выполн\p{L}*|терминал|команд\p{L}*|shell|npm |pnpm |yarn |pytest|git |dir |list_dir|write_file|run_terminal|удал\p{L}*|открой url|браузер|web_search|\bls\b|\bdir\b)/iu.test(
      trimmed,
    ) ||
    /\b(run|execute|delete|remove|open|browse|search files|list (files|dir))\b/i.test(trimmed);
  if (shellOrBrowse) return true;
  if (!hasProject) return false;
  return /(файл|код|проект|папк|каталог|исправ|добав|удал|созда|напиш|перепиш|проверь|запуст|терминал|рефактор|@|\.py|\.ts|\.js|readme|agents\.md|search|list_dir|write_file)/i.test(
    trimmed,
  );
}

export function detectAgentTask(
  text: string,
  opts?: { projectRoot?: string | null },
): boolean {
  const hasProject = Boolean(opts?.projectRoot && String(opts.projectRoot).trim());
  if (detectCodingTask(text) || detectToolAction(text, hasProject)) return true;
  if (hasProject && detectShortProjectTask(text)) return true;
  return false;
}

/**
 * Live / factual questions that need web search in plain chat
 * (weather, news, rates, “today”, scores) — local GGUF has no internet.
 */
export function detectLiveWebNeed(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 500) return false;
  return (
    /(погод\p{L}*|weather|forecast|прогноз\p{L}*)/iu.test(trimmed) ||
    /(курс\p{L}*\s+(доллар|евро|юан|рубл)|exchange rate|bitcoin|btc\b|eth\b)/iu.test(
      trimmed,
    ) ||
    /(новост\p{L}*|news\b|заголовк\p{L}*|headline)/iu.test(trimmed) ||
    /(сколько\s+сейчас|какая\s+сегодня|что\s+сегодня|актуальн\p{L}*|на\s+сегодня|right now|current (weather|price|news))/iu.test(
      trimmed,
    ) ||
    /(температур\p{L}*\s+в\s+|в\s+москве|в\s+питер|в\s+санкт)/iu.test(trimmed)
  );
}

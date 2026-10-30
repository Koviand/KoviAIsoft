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
    /(напис\p{L}*|напиш\p{L}*|созда\p{L}*|сдела\p{L}*|реализ\p{L}*|постро\p{L}*|исправ\p{L}*|добав\p{L}*|перепиш\p{L}*|рефактор\p{L}*).{0,100}(игр[уыае]|программ\p{L}*|скрипт\p{L}*|файл\p{L}*|проект\p{L}*|приложени\p{L}*|код\p{L}*|модул\p{L}*|функци\p{L}*|класс\p{L}*|auth|tetris|тетрис|\.py|\.ts|\.js|\.tsx|\.html|\.css|\.json)/iu.test(
      trimmed,
    ) ||
    /\b(write|create|implement|build|fix|edit|refactor|rewrite)\b.{0,80}\b(game|app|file|script|python|module|function|auth|tetris|code|\.py|\.ts|\.js|\.tsx|\.html)\b/i.test(
      trimmed,
    );
  if (ruEn) return true;
  // Shorter cues for force-write inside agent loop (need an action verb, not just a language name).
  return /(напиш|создай|сделай|реализ|добав|исправ|перепиш).{0,80}(файл|код|игр[ауые]|тетрис|tetris|скрипт|программ|модул|\.py|\.ts|\.js|\.tsx|\.html)/i.test(
    trimmed,
  ) ||
    /\b(write|create|implement|fix|edit).{0,60}(\.py|\.ts|\.js|\.tsx|file|script|game|tetris)\b/i.test(
      trimmed,
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
  return detectCodingTask(text) || detectToolAction(text, hasProject);
}

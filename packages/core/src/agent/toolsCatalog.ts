export const BUILTIN_TOOL_SPECS = [
  {
    name: "list_dir",
    description: "Список файлов и папок в директории",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "read_file",
    description: "Прочитать текстовый файл",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Записать файл целиком (создаёт/перезаписывает). В content — полный исходный код, не stub и не комментарий-заглушка.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "apply_patch",
    description: "Заменить фрагмент в файле",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        oldText: { type: "string" },
        newText: { type: "string" },
      },
      required: ["path", "oldText", "newText"],
    },
  },
  {
    name: "delete_path",
    description: "Удалить файл или папку (требует подтверждения)",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "search",
    description: "Поиск текста в файлах проекта",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        path: { type: "string" },
      },
      required: ["query", "path"],
    },
  },
  {
    name: "run_terminal",
    description:
      "Выполнить команду в Windows shell (cmd.exe). cwd — папка проекта. Для PowerShell: command=\"powershell Get-ChildItem\". Требует подтверждения.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "Команда Windows: dir, type, npm, python, git… (не bash). PowerShell: префикс powershell …",
        },
        cwd: {
          type: "string",
          description: "Абсолютный путь рабочей папки (обычно projectRoot). Можно опустить — возьмётся папка проекта.",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "web_search",
    description: "Поиск в интернете",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "browser_navigate",
    description: "Открыть URL в браузере",
    parameters: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
  },
  {
    name: "browser_snapshot",
    description: "Снимок текста текущей страницы браузера",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "browser_click",
    description: "Клик по CSS-селектору",
    parameters: {
      type: "object",
      properties: { selector: { type: "string" } },
      required: ["selector"],
    },
  },
  {
    name: "browser_type",
    description: "Ввод текста в элемент",
    parameters: {
      type: "object",
      properties: {
        selector: { type: "string" },
        text: { type: "string" },
      },
      required: ["selector", "text"],
    },
  },
  {
    name: "finish",
    description: "Завершить задачу и дать финальный ответ пользователю",
    parameters: {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
    },
  },
] as const;

export type BuiltinToolName = (typeof BUILTIN_TOOL_SPECS)[number]["name"];

export const BUILTIN_TOOL_NAMES = new Set<string>(
  BUILTIN_TOOL_SPECS.map((t) => t.name),
);

const CORE_TOOL_NAMES = new Set([
  "list_dir",
  "read_file",
  "write_file",
  "apply_patch",
  "search",
  "run_terminal",
  "finish",
]);

export function toolsPromptBlock(
  extraTools: Array<{ name: string; description?: string }>,
  opts?: { compact?: boolean },
): string {
  const specs = opts?.compact
    ? BUILTIN_TOOL_SPECS.filter((t) => CORE_TOOL_NAMES.has(t.name))
    : BUILTIN_TOOL_SPECS;
  const extras = opts?.compact ? [] : extraTools;
  const all = [
    ...specs.map((t) => `- ${t.name}: ${t.description}`),
    ...extras.map((t) => `- ${t.name}: ${t.description || "MCP tool"}`),
  ];
  const rules = opts?.compact
    ? `Формат: JSON {"thought","tool":{"name","args"}|null,"final"|null}. Пиши код через write_file. Windows paths.`
    : `Формат ответа на каждом шаге — строго JSON в обычном тексте ответа (не в reasoning/thinking):
{
  "thought": "краткие рассуждения",
  "plan": [{"id":"1","title":"..."}],
  "tool": {"name":"tool_name","args":{...}} | null,
  "final": "текст пользователю если закончили" | null
}
Запрещены XML/Hermes tool_call и bash-heredoc — только JSON с tool.name из списка ниже.

Правила:
- Если нужно создать/изменить код или файлы — ОБЯЗАТЕЛЬНО вызывай write_file / apply_patch. Не клади длинный код в final.
- После plan сразу вызови write_file с ПОЛНЫМ кодом в args.content (не skeleton из 5–10 строк).
- list_dir / read_file не считаются выполнением задачи. final/finish только после реальной записи рабочих файлов.
- Не выдумывай, что файл уже создан: сначала write_file, потом final с путём и командой запуска.
- final — короткий итог (пути, как запустить), без огромных листингов.
- Если нужен инструмент — заполни tool и оставь final=null.
- ОС Windows: в run_terminal используй cmd (dir, type, del, copy, npm, python) или префикс powershell …. Bash (ls/cat/rm) адаптируется частично.
- Пути: относительно папки проекта или Windows absolute (C:\\\\…). Не используй Unix /Users/… — система сама поправит, но лучше относительные.
- Пустой cwd = папка проекта. Не удаляй корень проекта.
- Код пиши только через write_file/apply_patch, не через echo/cat/heredoc в shell.
- В system уже есть карта проекта и автоподобранные фрагменты (как @codebase в Cursor). Уточняй через search/read_file; можно опираться на пути из карты.`;
  return `Доступные инструменты:\n${all.join("\n")}\n\n${rules}`;
}

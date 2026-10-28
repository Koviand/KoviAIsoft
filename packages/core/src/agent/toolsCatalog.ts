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
    description: "Записать файл (создаёт/перезаписывает)",
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
    description: "Выполнить команду в shell (требует подтверждения)",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
      },
      required: ["command", "cwd"],
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

export function toolsPromptBlock(extraTools: Array<{ name: string; description?: string }>): string {
  const all = [
    ...BUILTIN_TOOL_SPECS.map((t) => `- ${t.name}: ${t.description}`),
    ...extraTools.map((t) => `- ${t.name}: ${t.description || "MCP tool"}`),
  ];
  return `Доступные инструменты:\n${all.join("\n")}

Формат ответа на каждом шаге — строго JSON:
{
  "thought": "краткие рассуждения",
  "plan": [{"id":"1","title":"..."}],
  "tool": {"name":"tool_name","args":{...}} | null,
  "final": "текст пользователю если закончили" | null
}

Правила:
- Если нужно создать/изменить код или файлы — ОБЯЗАТЕЛЬНО вызывай write_file / apply_patch. Не клади длинный код в final.
- После plan сразу вызови первый tool (обычно write_file). Нельзя завершать с final, пока файлы не созданы.
- final — короткий итог для пользователя (пути файлов, как запустить), без огромных листингов.
- Если нужен инструмент — заполни tool и оставь final=null.
- Если задача реально сделана инструментами — tool=null и заполняй final.`;
}

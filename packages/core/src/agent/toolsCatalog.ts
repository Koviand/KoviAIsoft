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
      "Выполнить команду в Windows (cmd.exe). cwd — папка проекта. PowerShell: префикс powershell …. Требует подтверждения. Код пиши через write_file, не через shell.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "Синтаксис cmd/PowerShell: dir, type, call npm test, python main.py, git status. НЕ bash (export, ls|grep, <<EOF, /Users/…). Цепочки: set \"X=1\" && call npm test. PowerShell: powershell Get-ChildItem.",
        },
        cwd: {
          type: "string",
          description:
            "Рабочая папка: относительный путь или C:/Users/... (слэш /). Можно опустить — projectRoot. В JSON один \\ = \"\\\\\".",
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
    ? `ТОЛЬКО один JSON {"thought","plan?","tool"|null,"final"|null} — без prose/markdown вокруг. Сначала plan (3–7, tool=null), потом один tool/шаг; plan не переписывать. Код — write_file кусками. Windows/cmd без bash.`
    : `Формат ответа на каждом шаге — строго ОДИН JSON-объект без текста до/после (сервер может требовать schema):
{
  "thought": "краткие рассуждения",
  "plan": [{"id":"1","title":"..."}],
  "tool": {"name":"tool_name","args":{...}} | null,
  "final": "текст пользователю если закончили" | null
}
Запрещены XML/Hermes tool_call, markdown-обёртки и bash-heredoc — только JSON с tool.name из списка ниже.

Двухфазный режим:
1) ФАЗА ПЛАНА (первый ответ): только plan из 3–7 коротких пунктов, tool=null, final=null.
2) ФАЗА ИСПОЛНЕНИЯ: план УЖЕ зафиксирован системой — НЕ меняй plan. Один tool за шаг по current_step. final только когда пункты сделаны (или остался «итог»).

Правила исполнения:
- Если нужно создать/изменить код или файлы — ОБЯЗАТЕЛЬНО write_file / apply_patch. Не клади длинный код в final.
- Не пихай всю игру/приложение в один JSON-шаг: ~80–150 строк за write_file, дальше модули отдельными шагами.
- list_dir / read_file не считаются выполнением кодинг-задачи. final/finish только после реальной записи рабочих файлов.
- Не выдумывай, что файл уже создан: сначала write_file, потом final с путём и командой запуска.
- final — короткий итог (пути, как запустить), без огромных листингов. thought — 1–2 предложения, без кода.
- Если нужен инструмент — заполни tool и оставь final=null.
- ОС Windows (cmd.exe по умолчанию):
  • OK: dir, type, del, copy, mkdir, call npm test, call npx …, python main.py, git status, set "VAR=1" && call npm test
  • PowerShell: префикс powershell … (пример: powershell Get-ChildItem)
  • НЕЛЬЗЯ: export, VAR=value cmd, <<EOF, $(…), backticks, /Users/…, /tmp/…, 2>/dev/null, ls|grep|cat>file
  • Одиночные ls/cat/rm/pwd система может адаптировать; цепочки пиши сразу на cmd.
- Пути в args: относительно проекта или C:/Users/Name/proj (слэш /). В JSON один \\ = "\\\\". Не учетверяй слэши. Unix-пути в command не исправляются — используй relative или C:/.
- Пустой cwd = папка проекта. Не удаляй корень проекта.
- Код пиши только через write_file/apply_patch, не через echo/cat/heredoc в shell.
- В system уже есть карта проекта и семантический @codebase (CPU-эмбеддинги) + keyword/rg. Пиши @codebase в запросе пользователя или опирайся на retrieved. Уточняй через search/read_file.`;
  return `Доступные инструменты:\n${all.join("\n")}\n\n${rules}`;
}

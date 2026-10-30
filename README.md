# KoviAIsoft

Локальный desktop-чат и агент для Windows: свои GGUF-модели через `llama.cpp`, без облака.

Стек: Electron + React + TypeScript (pnpm monorepo). Агент — Hermes-подобный JSON tool-loop с планом, подтверждениями и Windows-песочницей.

**Репозиторий:** https://github.com/Koviand/KoviAIsoft

---

## Возможности

| Область | Что умеет |
|--------|-----------|
| **Runtime** | Автоопределение GPU/CPU, установка/обновление `llama.cpp` (CUDA / Vulkan / CPU), в т.ч. архитектуры вроде LFM3 |
| **Модели** | Скан локальных GGUF, рекомендации под VRAM/RAM, скачивание с Hugging Face (встроенный HF CLI в portable), выбор папки загрузки, удаление с диска |
| **Чат** | Стриминг, параметры генерации, system prompt, сжатие истории / working memory |
| **Агент** | План, инструменты (файлы, терминал, поиск, браузер), `@agent` / авто-intent, подтверждение опасных действий, force-write для coding-задач |
| **Безопасность** | Path sandbox + junctions, cwd shell ⊆ project/modelRoots, deny `cd` вне roots, SSRF в браузере, таймаут подтверждений |
| **Прочее** | MCP, OpenAI-совместимый локальный proxy, монитор VRAM/tok/s, темы UI, онбординг |

---

## Требования

- Windows x64
- Node.js 20+
- pnpm 9+
- GPU NVIDIA/AMD или CPU — по железу

---

## Быстрый старт (portable)

Сборка одной папки, которую можно копировать на другой ПК:

```bash
pnpm install
pnpm pack
```

Результат: `release\KoviAIsoft-Portable\`

| Путь | Назначение |
|------|------------|
| `KoviAIsoft.exe` | Запуск |
| `data\` | Настройки, чаты, runtime |
| `tools\hf\` | Встроенный Hugging Face CLI (preseed при pack) |
| `playwright-browsers\` | Chromium для агента |
| `resources\ui\` | UI |

Также появляется single-file portable в `release\builder-out\`.

`pnpm pack` перед сборкой делает `taskkill` для `KoviAIsoft.exe`, чтобы разблокировать папку release.

---

## Разработка

```bash
git clone https://github.com/Koviand/KoviAIsoft.git
cd KoviAIsoft
pnpm install
```

Браузерные инструменты агента (один раз):

```bash
pnpm playwright:install
```

Два терминала:

```bash
pnpm dev:ui
pnpm dev:desktop
```

Проверки:

```bash
pnpm typecheck
pnpm test
```

CI: `.github/workflows/ci.yml` (Windows: typecheck + test).

Данные в dev: обычно `%APPDATA%\KoviAIsoft\` (в portable — `data\` рядом с EXE).

---

## Сценарий использования

1. **Runtime** → установить llama.cpp (или дождаться тихого автообновления).
2. **Модели** → выбрать папку загрузки / сканирования → скачать GGUF с HF или указать локальные файлы → **Загрузить в память**.
3. **Настройки** → папка проекта (для агента и `AGENTS.md`), режим подтверждений (Ask / Auto-safe / Full), тема.
4. **Чат** → обычный диалог; для кода и файлов — `@agent …` или включённые tools у сессии (intent routing тоже может включить агента).
5. **Монитор** → VRAM, tok/s, контекст.

Остановка генерации — кнопка Stop в topbar.

---

## Структура репозитория

```
apps/ui          — React UI
apps/desktop     — Electron main / preload
packages/core    — агент, чат, runtime, tools, HF, store
packages/shared  — типы и IPC-контракт
scripts/         — pack-portable и smoke
tests/           — vitest
```

---

## Заметки

- Только локальные модели; токены HF/GitHub опциональны (gated-репо / rate limit).
- Агент адаптирует Unix-команды под Windows (`cmd` / PowerShell); запись кода через heredoc запрещена — используйте `write_file`.
- Если `git push` просит credentials: `gh auth login` или SSH/PAT.

---

## Лицензия / статус

Проект в активной разработке (`0.1.0`). Issues и PR — в GitHub-репозитории выше.

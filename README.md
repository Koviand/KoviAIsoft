# KoviAIsoft

Локальное Windows-приложение в духе LM Studio + Hermes agent:

- автоопределение системы и установка нужного `llama.cpp` (CUDA / Vulkan / CPU), включая поддержку архитектур вроде LFM3;
- чаты со стримингом, system prompt и параметрами генерации;
- агент с планом, tool-loop, подтверждением опасных действий;
- MCP, web search, браузер (Playwright);
- только локальные модели.

## Требования

- Windows x64
- Node.js 20+
- pnpm 9+
- NVIDIA/AMD/CPU — по железу

## Установка

```bash
git clone https://github.com/Koviand/KoviAIsoft.git
cd KoviAIsoft
pnpm install
```

Для браузер-инструментов агента:

```bash
pnpm --filter @kovi/core exec playwright install chromium
```

## Запуск (dev)

Терминал 1:

```bash
pnpm dev:ui
```

Терминал 2:

```bash
pnpm dev:desktop
```

## Portable EXE (одна папка, можно копировать на другой ПК)

```bash
pnpm pack
```

Готовая папка:
`release\KoviAIsoft-Portable\`
- `KoviAIsoft.exe` — запуск
- `data\` — настройки, чаты, скачанный llama.cpp
- `playwright-browsers\` — Chromium для агента
- `resources\ui\` — интерфейс

Скопируйте всю папку `KoviAIsoft-Portable` на другой Windows x64 ПК и запустите EXE.
Также создаётся single-file portable в `release\builder-out\`.

## Быстрый сценарий

1. Откройте **Runtime** → «Установить сейчас» (или дождитесь тихого автообновления).
2. **Модели** → «Обновить список» (по умолчанию `C:\Models\LFM`) или скачайте GGUF с HF.
3. Нажмите **Загрузить в память** у нужной модели.
4. В **Чат** отправьте сообщение (при необходимости включите режим «Агент»).
5. В **Настройках** выберите папку проекта для агента. Откройте **Монитор** для VRAM/tok/s.

Данные приложения: `%APPDATA%\KoviAIsoft\`

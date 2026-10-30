# Установка и сборка KoviAIsoft

Инструкция для разработчиков и тех, кто собирает portable EXE из исходников.  
Описание программы — в [README.md](README.md).

---

## Требования

- Windows x64
- [Node.js](https://nodejs.org/) 20+
- [pnpm](https://pnpm.io/) 9+ (`corepack enable` или `npm i -g pnpm`)
- Для GPU-сборок llama.cpp: драйверы NVIDIA (CUDA) или Vulkan — по железу

---

## Клонирование и зависимости

```bash
git clone https://github.com/Koviand/KoviAIsoft.git
cd KoviAIsoft
pnpm install
```

`postinstall` соберёт `@kovi/shared` и `@kovi/core`.

### Playwright (браузер агента)

Нужен, если используете инструменты браузера в агенте:

```bash
pnpm playwright:install
```

В portable-сборке Chromium кладётся в `playwright-browsers\` рядом с EXE.

---

## Запуск в режиме разработки

Два терминала:

```bash
pnpm dev:ui
```

```bash
pnpm dev:desktop
```

UI по умолчанию: `http://127.0.0.1:5173`.  
Данные приложения в dev: обычно `%APPDATA%\KoviAIsoft\`.

---

## Проверки

```bash
pnpm typecheck
pnpm test
```

CI на push/PR: `.github/workflows/ci.yml` (runner `windows-latest`).

---

## Сборка portable EXE

Одна папка, которую можно копировать на другой Windows x64 ПК:

```bash
pnpm pack
```

Перед упаковкой скрипт может завершить запущенный `KoviAIsoft.exe` (`taskkill`), чтобы разблокировать `release\`.

### Результат

| Путь | Содержимое |
|------|------------|
| `release\KoviAIsoft-Portable\KoviAIsoft.exe` | Запуск |
| `release\KoviAIsoft-Portable\data\` | Настройки, чаты, скачанный runtime |
| `release\KoviAIsoft-Portable\tools\hf\` | Встроенный Hugging Face CLI (preseed при pack) |
| `release\KoviAIsoft-Portable\playwright-browsers\` | Chromium для агента |
| `release\KoviAIsoft-Portable\resources\ui\` | Собранный UI |
| `release\builder-out\` | Дополнительно: unpacked и single-file portable от electron-builder |

Скопируйте **всю** папку `KoviAIsoft-Portable` на целевой ПК и запустите EXE.  
Для работы HF CLI / обновления runtime на чистом ПК нужна сеть при первом скачивании.

### Что делает pack

1. `pnpm build` (shared → core → ui → desktop)
2. esbuild main/preload в stage
3. electron-builder (dir + portable)
4. Сборка `KoviAIsoft-Portable` с сохранением существующих `data\` / `playwright-browsers\`
5. Preseed встроенного HF CLI в `tools\hf\`

Скрипт: [`scripts/pack-portable.mjs`](scripts/pack-portable.mjs).

---

## Полезные команды

| Команда | Назначение |
|---------|------------|
| `pnpm build` | Полная сборка пакетов |
| `pnpm pack` / `pnpm pack:win` | Portable EXE |
| `pnpm test` | Vitest |
| `pnpm typecheck` | TypeScript во всех пакетах |
| `pnpm smoke:lfm3` | Smoke-скрипт (см. `scripts/`) |

---

## Git / credentials

Если `git push` на GitHub зависает на логине:

```bash
gh auth login
```

или настройте SSH / PAT для `https://github.com/Koviand/KoviAIsoft`.

# Установка и сборка KoviAIsoft

Инструкция для разработчиков и тех, кто собирает **Setup EXE** или portable из исходников.  
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
В установленной (Setup) версии — в `%APPDATA%\KoviAIsoft\playwright-browsers\`.

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

## Сборка Setup и portable

Одна команда собирает **установочный NSIS Setup EXE** и portable-папку:

```bash
pnpm pack
# или: pnpm pack:win / pnpm pack:setup
```

Перед упаковкой скрипт может завершить запущенный `KoviAIsoft.exe` (`taskkill`), чтобы разблокировать `release\`.

### Результат

| Путь | Содержимое |
|------|------------|
| `release\KoviAIsoft-Setup-0.1.0.exe` | **Установщик** (ярлыки, выбор папки, данные в `%APPDATA%\KoviAIsoft`) |
| `release\KoviAIsoft-Portable\KoviAIsoft.exe` | Portable-запуск (данные рядом с EXE) |
| `release\KoviAIsoft-Portable\.kovi-portable` | Маркер portable-режима |
| `release\KoviAIsoft-Portable\data\` | Настройки, чаты, runtime (только portable) |
| `release\KoviAIsoft-Portable\tools\hf\` | Встроенный Hugging Face CLI |
| `release\KoviAIsoft-Portable\playwright-browsers\` | Chromium для агента |
| `release\builder-out\` | Unpacked, portable single-file, исходный Setup от electron-builder |

**Setup:** запустите `KoviAIsoft-Setup-*.exe` → мастер установки → ярлык на рабочем столе / в меню Пуск.  
Данные: `%APPDATA%\KoviAIsoft\`.

**Portable:** скопируйте **всю** папку `KoviAIsoft-Portable` и запустите EXE.  
Данные: `.\data\` рядом с программой.

Для HF CLI / обновления runtime на чистом ПК нужна сеть при первом скачивании.

### Что делает pack

1. `pnpm build` (shared → core → ui → desktop)
2. esbuild main/preload в stage
3. electron-builder (`dir` + `portable` + `nsis`)
4. Копирование Setup в `release\`
5. Сборка `KoviAIsoft-Portable` (+ маркер `.kovi-portable`)
6. Preseed HF CLI в `tools\hf\`

Скрипт: [`scripts/pack-portable.mjs`](scripts/pack-portable.mjs).

---

## Полезные команды

| Команда | Назначение |
|---------|------------|
| `pnpm build` | Полная сборка пакетов |
| `pnpm pack` / `pnpm pack:win` / `pnpm pack:setup` | Setup EXE + portable |
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

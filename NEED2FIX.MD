# NEED2FIX — аудит KoviAIsoft

Дата: 2026-10-29 (обновлено: 2026-10-30 — правки внесены)  
Область: core, shared, UI, desktop/IPC, тесты, pack/релиз.

Легенда приоритетов:

- **P0** — риск потери данных / безопасности / явный баг UX прямо сейчас
- **P1** — высокий: гонки, неверная семантика, незакрытая миграция, релизный drift
- **P2** — техдолг, производительность, a11y, документация

---

## Сводка

| Зона | Главные темы |
|------|----------------|
| Core / FS | wipe `store.json`, shell вне sandbox, junction delete, atomic tmp |
| Chat / Agent | dual `stream`+`token`, cancel→error, Stop vs acceptsStream, timeline races |
| Security | disk-mode shell RCE, browser SSRF, MCP env leak, monitor preload |
| Product migration | `toolsEnabled` мёртв для routing, dead IPC, README drift |
| Release | GitHub push auth, pack version skew, нет CI |

---

## P0 — критично

### P0-1. Повреждение / wipe `store.json` при ошибке чтения — **СДЕЛАНО**
**Где:** `packages/core/src/db/store.ts` (`load`)  
Corrupt JSON → `.bak` + empty; I/O fail → `blockPersist` (не затирать диск).

### P0-2. Shell sandbox ≠ file sandbox (disk mode) — **СДЕЛАНО**
**Где:** `assertTerminalCwd`, `terminal.ts`, тесты  
Disk cwd ⊆ `modelRoots` ∪ `projectRoot`.

### P0-3. `delete_path` recursive + Windows junctions — **СДЕЛАНО**
**Где:** `files.ts`  
Walk с `lstat`; reparse/symlink unlink без follow.

### P0-4. Дублирование финального ответа: `stream` + `token` — **СДЕЛАНО**
Агент эмитит только `stream`; UI игнорирует `token`.

### P0-5. Stop разблокирует UI, стрим продолжается — **СДЕЛАНО**
Generation epoch + `streamSessionRef`; Stop инвалидирует epoch.

### P0-6. Cancel чата → `cancelled` + повторный `error` — **СДЕЛАНО**
`sendChat` не rethrow после cancel; IPC catch игнорирует Abort/«Отменено».

### P0-7. `toolsEnabled` / routing — **СДЕЛАНО**
`preferAgent = opts.useAgent ?? sessionToolsEnabled(session)`; UI передаёт `useAgent` при `toolsEnabled`.

### P0-8. GitHub push без auth — **НЕ ЗАКРЫТО (нужен пользователь)**
Требуется `gh auth login` / PAT / SSH. Документация в README.

---

## P1 — высокий приоритет

| ID | Тема | Статус |
|----|------|--------|
| P1-1 | Timeline `setTimeout` + epoch | Сделано |
| P1-2 | События чужой сессии | Сделано (filter active + epoch) |
| P1-3 | Unmount Chat теряет процесс | Сделано (Chat hidden, not unmounted) |
| P1-4 | Chat abort → cancelled | Сделано |
| P1-5 | Confirmation UX | Сделано (Escape, busy lock, focus) |
| P1-6 | Mutex loadModel / startAgent | Сделано |
| P1-7 | writeFileAtomic unique tmp + lock | Сделано |
| P1-8 | Browser SSRF / risk | Сделано |
| P1-9 | Monitor preload | Сделано (`monitorPreload.ts`) |
| P1-10 | file: navigation | Сделано |
| P1-11 | Dual event bus leftovers | Частично (UI на agentEvent; chatToken deprecated) |
| P1-12 | Dead IPC wrappers | Сделано (deprecate + cancel→stop) |
| P1-13 | attachmentPaths | Сделано (удалены из контракта) |
| P1-14 | completeJson streaming | Частично (thinking heartbeat via context stats; full JSON stream — долг) |
| P1-15 | Context packer / small ctx | Сделано (compact tools + lower reserve) |
| P1-16 | parseAgentIntent | Сделано |
| P1-17 | MCP env allowlist | Сделано |
| P1-18 | Pack version skew | Сделано (версии из desktop pkg) |
| P1-19 | Delete session mid-gen | Сделано |
| P1-20 | IPC req validation | Сделано |
| P1-21 | README drift | Сделано |
| P1-22 | formatLlmFetchError abort | Сделано |
| P1-23 | CI | Сделано (`.github/workflows/ci.yml`) |

---

## P2 — средний / долг

| ID | Тема | Статус |
|----|------|--------|
| P2-1 | Agent rethrow | Частично (events остаются источником UI) |
| P2-2 | extractJson balanced | Сделано |
| P2-3 | isDangerousSystemDir | Сделано |
| P2-4 | ADS / path edges | Сделано |
| P2-5 | Store debounce shorter | Сделано (40ms) |
| P2-6 | searchFiles caps | Сделано |
| P2-7 | retrieve/map cache | Не сделано (долг) |
| P2-8 | Browser context per run | Частично (context lifecycle) |
| P2-9 | Proxy bearer | Сделано (`KOVI_PROXY_TOKEN`) |
| P2-10 | githubToken OS store | Не сделано (долг) |
| P2-11 | Dual token/stream types | Сделано (token deprecated) |
| P2-12 | wantsFiles / stub by ext | Сделано |
| P2-13 | Chat history condense | Не сделано (долг) |
| P2-14 | pickCompletionText | Не менялось (низкий риск) |
| P2-15 | sendMessage Promise\<void\> | Сделано |
| P2-16 | a11y мелочи | Сделано |
| P2-17 | Polling unify | Не сделано (долг) |
| P2-18 | shamefully-hoist | Не сделано (долг) |
| P2-19 | pack taskkill warning | Сделано |
| P2-20 | Тесты | Улучшено (store/SSRF/toolsEnabled) |
| P2-21 | started timing | Частично |
| P2-22 | Optimistic flicker | Частично (merge после done) |

---

## Чеклист «сделано / не сделано»

| Тема | Статус |
|------|--------|
| Unified composer | Сделано |
| ProcessTimeline фиксы P0/P1 | Сделано |
| Fire-and-forget + cancel | Сделано |
| Context engine trim | Улучшено |
| Windows FS / junctions | Сделано |
| llama-server stdout drain | Закрыто ранее |
| GitHub push | **Не закрыто (P0-8 — нужен `gh auth login`)** |
| attachmentPaths | Удалены из API |
| Agent JSON streaming | Частично |
| CI | Сделано |
| `pnpm test` / `typecheck` | Зелёные на момент правок |

---

*Правки по пунктам внесены в код 2026-10-30. Оставшийся долг: P0-8 (auth у пользователя), P1-14 full stream parse, P2-7/10/13/17/18.*

# NEED2FIX — аудит KoviAIsoft

Дата: 2026-11-02 (High+Mid+Verify + audit pass-2)  
Область: safeStorage secrets, git_pull/askpass, attachments, stop reasons, watcher, resume/goal, git timeout/GCM, cmd quoting, constraint overflow, UI races.

Легенда: **pass** ок · **fix** исправлено в этой волне · **smoke** ручная проверка

---

## Full function matrix (2026-10-30)

### Boot / Settings
| Функция | Статус | Примечание |
|---------|--------|-----------|
| init / dispose | pass | AppService lifecycle |
| getSystemInfo | fix | VRAM registry + pickMaxVram |
| getSettings / saveSettings | fix | agentMaxSteps 0; auto-extend/maxRunMinutes; Tavily key; githubToken safeStorage |
| onboarding wizard | pass | Движок/папки/тема |

### Runtime
| Функция | Статус | Примечание |
|---------|--------|-----------|
| detectRuntimeAsset | pass | |
| installRuntime / ensureLatestRuntime | pass | |
| checkRuntimeUpdate | pass | |
| getRuntimeStatus | fix | loadedContext + loadedGpuLayers |
| loadModel / unloadModel | fix | единый estimateLoadPlan, без silent min(scanner) |
| runtimeProgress event | pass | |
| Monitor snapshot / open / alwaysOnTop | fix | UI на push IPC, без второго polling |

### Models / HF
| Функция | Статус | Примечание |
|---------|--------|-----------|
| listModels / scanModels | fix | estimateFit = estimateLoadPlan |
| deleteModel / verifyGguf | pass | тесты |
| getModelRecommendations | fix | pickMaxVram |
| suggest/applyHardware / applyLoadProfile | fix | auto-reload loaded model |
| ModelAdvancedSettings gen sync | fix | activeSessionId, не sessions[0] |
| searchHf / listHfFiles / downloadHfFile | pass | |
| getHfCliStatus / ensureHfCli | pass | |

### Chat
| Функция | Статус | Примечание |
|---------|--------|-----------|
| sessions CRUD | pass | |
| sendChat / sendMessage | fix | long maxTokens + auto-continue ×2 |
| stopGeneration | pass | chat+agent |
| session params UI | fix | только gen (temp/topP/maxTokens); ctx/ngl — read-only статус |
| Continue (resume) | fix | после стопа/бюджета без полного replan |
| @-picker | fix | listProjectMentions + dropdown файлов/@codebase/@agent |
| export/import session | pass | + exportSessionFolder |
| pin / pinned-only filter | fix | Chat sidebar |
| openPath (клик по пути) | fix | shell.openPath / showItemInFolder |
| chatToken event | pass | |

### Agent
| Функция | Статус | Примечание |
|---------|--------|-----------|
| startAgent / cancelAgent | pass | stopGeneration alias |
| resolveConfirmation | pass | |
| multi-diff review panel | fix | Accept/Reject + Откатить (checkpoint) |
| plan/parse/tools | fix | plan↔tool; tools[]≤3 RO; git_*; fingerprint |
| budget exhaust | fix | incomplete + banner «Продолжить»; auto-extend settings |
| completeJson | fix | tools → json_schema → grammar → Hermes |
| checkpoints | fix | `.kovi/checkpoints/<runId>/…` + restore IPC |
| project memory rules | fix | AGENTS.md + `.cursor/rules` + `.kovi/rules` ≤6k |
| write → @codebase | fix | await invalidateIndexPaths + invalidateRoot |
| files/shell/browser/web | pass | stderr Диагностика; Tavily+DDG harden |

### Embeddings / @codebase
| Функция | Статус | Примечание |
|---------|--------|-----------|
| list/getEmbeddingStatus | pass | |
| download/setEmbeddingModel | pass | UI на Движок; reindex on set |
| reindex / getCodebaseIndexStatus | pass | |
| listProjectMentions | fix | IPC для @-picker |
| retrieve @codebase | fix | cache invalidateRoot после мутаций |

### MCP / Proxy
| Функция | Статус | Примечание |
|---------|--------|-----------|
| checkMcpHealth | pass | |
| MCP UI add/toggle/delete/presets | pass | PageShell |
| OpenAI proxy start/stop | pass | via saveSettings |

### UI / Desktop IPC
| Функция | Статус | Примечание |
|---------|--------|-----------|
| Все IPC invoke ↔ preload ↔ main | pass | ipc-contract.test (+ listProjectMentions) |
| pickDirectory / pickFile | pass | |
| previewFileDiff | pass | |
| getErrorLog / getStatusBar | pass | |
| Pages: Chat/Models/Движок/Settings/MCP | fix | структура + preferModelId |

---

## Волна 0 — anti-loop (закрыто)

- Finish window (последние 2 шага)
- Caps: repair 3, truncation 3, identical tool 2, non-advancing 4
- final/finish на последнем шаге даже без файлов (+ пометка)
- Budget exhaust → synthesize итог из working memory
- completeJson: boost до throw + schema hint
- agentMaxSteps 0=без лимита; auto-extend пока есть работа; finishOnly только без pending work
- step_done на repair/truncation/blocked ветках

---

## Cursor-like stability (закрыто)

- A: gen vs load params; Advanced → active session; await index invalidate
- B: JSON stream harden; Continue; tighter non-advancing
- C: @picker; multi rules; agent changes panel
- D: Monitor push-only; retrieve invalidateRoot; githubToken safeStorage
- E: build:shared/core, typecheck green, vitest 191

---

## Verify 2026-11-02 (shipped)

| Фича | Статус |
|------|--------|
| Anti-loop / finishPolicy | pass |
| Checkpoints + Откатить | pass |
| git_* (+ git_pull, askpass env) | pass |
| tools[] batch ≤3 | pass |
| native tool_calls cascade | pass |
| Tavily | pass |
| SQLite migrate | pass |
| pin / export folder | pass |
| openPath | pass |
| Monitor push-only | pass |

## Открыто / у пользователя

### P0-8. GitHub push auth
PAT в Settings + «Проверить token»; SSH/`gh auth login` по желанию. Askpass больше не пишет PAT в файл.

---

## Остаточный долг (P2)

| ID | Тема |
|----|------|
| P2-18 | shamefully-hoist |
| P2-IDE | Monaco / Tab / Cmd+K — вне скоупа (отдельный продукт) |

Закрыто в High+Mid+Verify: hf/Tavily safeStorage, git_pull, attachments, incomplete reasons, confirm timeout, FS watcher, i18n chrome, rejectProseReasoning, loop phases, CI build.

Закрыто в audit pass-2: confirm resolve types; HF save без plaintext secrets; soft-resume goal; plan/repair hard-stop; non-advancing nudge→×3 stop; git timeout+GCM+validation; cmd verbatim args; context-overflow ≠ constraint reject; chat abort race; importSession id remap; sendMessage intent без attachments; secrets before init; updateSession preserves scratchpad; limitBanner/folderDraft UI.

Закрыто в P2 residual: MCP withTimeout+mcpSyncChain; agent вне loadModelChain; tool persist 20KB; assertSessionPatch; Settings dirty/saveSeq; HF recursive+Link; import folder bundle; confirmation timeoutSec; rg `-e`.

---

## Smoke checklist (ручной)

1. Загрузка GGUF → чат короткий ответ
2. Длинный ответ (не режется на 4k)
3. Параметры чата: нет ctx/ngl; статус «Загружено: ctx=… ngl=…»
4. Advanced → gen sync в **активную** сессию
5. @agent маленькая задача → final
6. @agent большая → итог / banner лимита → «Продолжить»
7. Stop mid-flight → кнопка «Продолжить»
8. @-picker файлов + @codebase
9. @codebase после write агента — свежий текст
10. AGENTS.md + `.cursor/rules/*.md` подхватываются
11. Confirm → панель «Изменения агента» Accept/Reject/Откатить
12. Клик по пути в чате → openPath
13. Pin сессии + «только закреплённые» + экспорт папки
14. Settings: auto-extend / max run minutes / Tavily
15. HF search + download
16. Движок: embedding MiniLM/LFM
17. MCP health
18. Под этот ПК → reload модели
19. GitHub token сохраняется (desktop safeStorage)

Авто: `tests/e2e-agent-smoke.test.ts`, `git-tools`, `sqlite-store`.

---

## Регрессия

- `pnpm build:shared` + `pnpm build:core`
- `pnpm typecheck` — green
- `pnpm test` — e2e/git/sqlite + прежние

*Обновлено при High+Mid sprint.*

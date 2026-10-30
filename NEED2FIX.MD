# NEED2FIX — аудит KoviAIsoft

Дата: 2026-10-30 (Cursor-like stability + anti-loop)  
Область: params consistency, agent finish/JSON, @picker/rules/diffs, retrieve cache, safeStorage.

Легенда: **pass** ок · **fix** исправлено в этой волне · **smoke** ручная проверка

---

## Full function matrix (2026-10-30)

### Boot / Settings
| Функция | Статус | Примечание |
|---------|--------|-----------|
| init / dispose | pass | AppService lifecycle |
| getSystemInfo | fix | VRAM registry + pickMaxVram |
| getSettings / saveSettings | fix | clamp agentMaxSteps 8…128; githubToken via safeStorage |
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
| export/import session | pass | ipcValidate |
| chatToken event | pass | |

### Agent
| Функция | Статус | Примечание |
|---------|--------|-----------|
| startAgent / cancelAgent | pass | stopGeneration alias |
| resolveConfirmation | pass | |
| multi-diff review panel | fix | Accept/Reject по файлу поверх confirm |
| plan/parse/tools | fix | finish window, repair/truncation/identical/non-advancing=4 |
| budget exhaust | fix | synthesize summary |
| completeJson | fix | balanced draft emit + schema hint on boost |
| project memory rules | fix | AGENTS.md + `.cursor/rules` + `.kovi/rules` ≤6k |
| write → @codebase | fix | await invalidateIndexPaths + invalidateRoot |
| files/shell/browser/web | pass | sandbox/ssrf/redirect tests |

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
- clamp agentMaxSteps 8…128
- step_done на repair/truncation/blocked ветках

---

## Cursor-like stability (закрыто)

- A: gen vs load params; Advanced → active session; await index invalidate
- B: JSON stream harden; Continue; tighter non-advancing
- C: @picker; multi rules; agent changes panel
- D: Monitor push-only; retrieve invalidateRoot; githubToken safeStorage
- E: build:shared/core, typecheck green, vitest 191

---

## Открыто / у пользователя

### P0-8. GitHub push без auth
`gh auth login` / PAT / SSH. (Токен в Движке — только для API Releases llama.cpp, не для git push.)

---

## Остаточный долг (P2)

| ID | Тема |
|----|------|
| P2-18 | shamefully-hoist |
| P2-IDE | Monaco / Tab / Cmd+K — вне скоупа (отдельный продукт) |

Закрыто в этой волне: P2-7 (invalidateRoot), P2-10 (safeStorage), P2-17 (Monitor push), P1-14 (balanced JSON draft).

---

## Smoke checklist (ручной)

1. Загрузка GGUF → чат короткий ответ
2. Длинный ответ (не режется на 4k)
3. Параметры чата: нет ctx/ngl; статус «Загружено: ctx=… ngl=…»
4. Advanced → gen sync в **активную** сессию
5. @agent маленькая задача → final
6. @agent большая → итог без бесконечного repair
7. Stop mid-flight → кнопка «Продолжить»
8. @-picker файлов + @codebase
9. @codebase после write агента — свежий текст
10. AGENTS.md + `.cursor/rules/*.md` подхватываются
11. Confirm → панель «Изменения агента» Accept/Reject
12. HF search + download
13. Движок: embedding MiniLM/LFM
14. MCP health
15. Под этот ПК → reload модели
16. GitHub token сохраняется (desktop safeStorage), не ломает проверку runtime

---

## Регрессия

- `pnpm build:shared` + `pnpm build:core`
- `pnpm typecheck` — green
- `pnpm test` — 191 passed

*Обновлено при Cursor-like stability.*

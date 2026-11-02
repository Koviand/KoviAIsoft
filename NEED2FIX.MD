# NEED2FIX — аудит KoviAIsoft

Дата: 2026-11-02 (Pass-2 logic audit после Full polish A–E)  
Область: security (.git/MCP), Stop/busy races, confirm UI, agent finish/tools[], chat truncation, settings/index/embed/IPC.

Легенда: **pass** ок · **fix** исправлено в этой волне · **smoke** ручная проверка

---

## Full function matrix (актуально)

### Boot / Settings
| Функция | Статус | Примечание |
|---------|--------|-----------|
| init / dispose | pass | |
| getSettings / saveSettings / patch | fix | `settings.patch` без RMW; applyLoadProfile перечитывает latest |
| getEffectiveSettings | pass | secrets для Tavily |
| internetAccessMode | pass | off / ask / allow |
| Settings draft secrets | fix | `__secure__` не попадает в editable fields |

### Runtime / Embeddings
| Функция | Статус | Примечание |
|---------|--------|-----------|
| ensureInstalled / throttle | pass | |
| loadModel / unloadModel | pass | |
| semanticIndex single-flight | fix | повторный join после await |
| EmbeddingServer | fix | exit только текущего child; no respawn после stop |
| loadVectors align | pass | |

### Chat / Agent
| Функция | Статус | Примечание |
|---------|--------|-----------|
| sendChat busy gate | fix | `isGenerationBusy()`; abort до assertLlmReady |
| startAgent Stop during lock | fix | `agentStartAbort`; AGENT_BUSY без terminal error |
| ChatPage stale done | fix | busy только при `streamSession` match |
| soft-resume sticky writes | fix | `writtenPaths` / `hadSubstantialWrite` |
| tools[] + finish_only | fix | batch blocked in finish window |
| identical tool hard-stop | fix | no_progress после nudge+ |
| finalize ≠ pendingWork | fix | finish window включается |
| finish ↔ mustWork | fix | симметрия с final |
| truncation / native tools | fix | boost при early bal; rejectBrokenArgs |
| batch coerce + unbill | fix | |
| finish_only inject | fix | без executePhaseHint |
| chat auto-continue | fix | system+user+assistant tail |

### Security / Confirm / Tools
| Функция | Статус | Примечание |
|---------|--------|-----------|
| `.git` writes | fix | blocked in assertNotInternalProjectPath |
| git spawn harden | fix | hooksPath= + fsmonitor off; askpass host-aware |
| MCP remember | fix | rememberKey null; resolve canRemember; high skip remember |
| confirm timeout UI | fix | agentChanges → rejected; silent resolve ≠ accepted |
| browser SSRF | fix | ::ffff:v4; xhr/fetch/ws gated |
| IPC attachments | fix | sendChat / startAgent pass attachments |

---

## Закрыто в Pass-2

### Wave 1 P0
- Block `.git` writes; git `-c core.hooksPath=` / fsmonitor off; askpass hostname-aware

### Wave 2
- agentStartAbort; chat abort before LLM ready; sendChat busy; ChatPage streamSession owns busy; AGENT_BUSY silent

### Wave 3
- MCP/high remember bypass closed; timeout → rejected changes; resolve returns boolean

### Wave 4
- finish_only vs tools[]; identical hard-stop; pendingWork finalize; finish mustWork; truncation boost; sticky writes; batch coerce/unbill; phase inject

### Wave 5
- settings.patch; applyLoadProfile latest; index single-flight; embed child/stop; IPC attachments; secure draft; SSRF; continue context; incomplete copy

### Wave 6–7
- `tests/pass2-regressions.test.ts` + sandbox; vitest green; this matrix

---

## Открытый долг (сознательно)

| ID | Тема |
|----|------|
| P2-18 | shamefully-hoist |
| P2-IDE | Monaco / Tab / Cmd+K |
| P0-8 | GitHub push auth UX (у пользователя) |

**P0/P1 логических поломок из Pass-2: нет.**

---

## Smoke checklist

1. Stop во время старта агента (load) → cancelled, агент не стартует  
2. Режим Чат / Агент + stale done не сбрасывает busy нового запроса  
3. write в `.git/config` → ошибка sandbox  
4. MCP confirm: нет «до конца диалога»; IPC remember не сохраняет  
5. Confirm timeout → rejected в панели изменений  
6. Finish window: tools[] → nudge final  
7. Soft-resume после многих shell notes → filesWritten из sticky paths  
8. Settings: после hardware apply токены не показывают `__secure__`

Авто: `pnpm exec vitest run` (279+ tests).

---

## Регрессия

```text
pnpm build:shared && pnpm build:core
pnpm typecheck
pnpm exec vitest run
```

*Обновлено: Pass-2 logic audit 2026-11-02.*

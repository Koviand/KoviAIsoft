# NEED2FIX — аудит KoviAIsoft

Дата: 2026-10-30 (полный аудит + стабилизация GGUF)  
Область: core, shared, UI, desktop/IPC, embeddings, agent, pack.

Легенда: **P0** критично · **P1** высокий · **P2** долг

---

## Сводка (после волны Full audit)

| Зона | Статус |
|------|--------|
| Embeddings / @codebase | Hash-fallback убран в prod; cwd/mutex embedding-server; force/dim/corrupt rebuild |
| Agent JSON contract | Strict parse, Hermes fallback, stepId↔plan, repair nudges, plan fail/advance |
| Runtime safety | load/unload/startAgent на одном chain; busy-guards UI |
| Shell sandbox | Redirects / Out-File / curl -o / EncodedCommand |
| GGUF families | modelFamily + tuning; HF HTTP token; integrity min size |
| Pack | onnxruntime-node в stage deps |

---

## Открыто / у пользователя

### P0-8. GitHub push без auth — **НУЖЕН ПОЛЬЗОВАТЕЛЬ**
`gh auth login` / PAT / SSH. Документация в README.

---

## Закрыто в волне Full audit (2026-10-30)

- Prod MiniLM hash-fallback → явная ошибка / ready:false
- Embedding server: cwd, mutex, stderr, L2-normalize, await resetEmbedder
- Index: force после wait, dim check, corrupt vectors → full rebuild; MiniLM = .onnx
- Retrieve: не эмбеддить пустой @codebase; lastSemanticError в thinking агента
- Shell redirects / EncodedCommand / -File path policy
- Risk `full`: честный UX-текст (high всё ещё ask)
- unloadModel + startAgent на loadModelChain; ban load при busy
- stepId = id шага плана; markCurrentPlanFailed; plan advance только substantive tools
- Phase hint раз в фазу; parse reject junk; Hermes XML; repair nudges
- Chat error без дубля IPC; лимит шагов → error+done incomplete
- modelFamily (qwen/deepseek/lfm/…) + temperature/json nudge
- Truncated broken JSON → LlmTruncatedError; load clamp после Advanced
- HF HTTP Authorization; GGUF min size 64KB
- Pack onnxruntime-node; UI embedding error / Models busy check

---

## Остаточный долг (P2)

| ID | Тема |
|----|------|
| P2-7 | retrieve/map cache invalidation после reindex (частично через projectContextCache.clear в agent) |
| P2-10 | githubToken в OS credential store |
| P2-17 | Unify polling |
| P2-18 | shamefully-hoist |
| P1-14 | Full streaming JSON parse mid-token (есть truncated + repair; deep stream parse — позже) |

---

## Ранее закрыто (не дублировать)

P0 wipe store, junctions, stream/token dual, Stop/cancel, toolsEnabled routing, SSRF navigate, CI, load tiers, dual embeddings UI.

---

*P2-13 chat history condense — сделано (`condenseTranscript` в agent/chat).*

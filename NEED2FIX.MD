# NEED2FIX — аудит KoviAIsoft

Дата: 2026-11-02 (Pass-6 — готовый продукт)  
Область: sendChat lock, deleteSession stop, SearXNG redirect SSRF, attachments allowlist, prep AbortSignal, MCP internet, attach-only send.

## Статус

**P0/P1 runtime-поломок: нет.**  
Авто: `pnpm typecheck` · `pnpm exec vitest run` (290+).

## Закрыто в Pass-6

- `sendChat` sync `chatStartLock` (TOCTOU)
- `deleteSession` stops generation for that session
- SearXNG/DuckDuckGo/Tavily: `redirect: manual` + SSRF re-check; AbortSignal
- Weather prep: AbortSignal
- Attachments: read only under `attachments/` dir
- Attach-only send → default «Обработай вложения.»
- MCP internet-off: broader name + URL-in-args gate

## Открытый долг (продуктовый скоуп, не баги)

| ID | Тема |
|----|------|
| P2-IDE | Monaco / Tab / Cmd+K (отдельный продукт) |
| P2-18 | shamefully-hoist (сборка) |
| P0-8 | GitHub push auth UX (у пользователя) |

---

```text
pnpm typecheck
pnpm exec vitest run
pnpm pack:setup   # по запросу
```

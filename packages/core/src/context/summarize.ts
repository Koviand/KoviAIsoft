import { estimateTokens, truncateToTokens } from "../chat/contextBudget.js";

export type TranscriptMsg = { role: string; content: string; toolName?: string };

/**
 * Extractive summary of older agent turns (no extra LLM call).
 * Keeps paths, tool names, errors — Cursor-like "conversation condensation".
 */
export function summarizeTranscript(
  messages: TranscriptMsg[],
  maxTokens = 400,
): string {
  if (!messages.length) return "";
  const bullets: string[] = [];
  for (const m of messages) {
    const c = m.content.replace(/\s+/g, " ").trim();
    if (!c) continue;
    if (m.role === "assistant") {
      const tool = c.match(/"name"\s*:\s*"([^"]+)"/);
      const path = c.match(/"path"\s*:\s*"([^"]+)"/);
      if (tool) {
        bullets.push(
          `- assistant → ${tool[1]}${path ? ` (${path[1]})` : ""}`,
        );
      } else {
        bullets.push(`- assistant: ${c.slice(0, 120)}`);
      }
      continue;
    }
    if (m.role === "user") {
      if (/Результат инструмента/i.test(c)) {
        const name = c.match(/Результат инструмента\s+(\S+):/i)?.[1] || "tool";
        const written = c.match(/Written\s+(\d+)\s+chars\s+to\s+(\S+)/i);
        const err = /ошибка|error|fail/i.test(c);
        if (written) bullets.push(`- ${name} ok: ${written[2]} (${written[1]} chars)`);
        else if (err) bullets.push(`- ${name} error: ${c.slice(0, 140)}`);
        else bullets.push(`- ${name}: ${c.slice(0, 140)}`);
      } else if (!/Ответ не JSON|Рано для final|finish отклон/i.test(c)) {
        bullets.push(`- user: ${c.slice(0, 160)}`);
      }
    }
  }
  // Dedup consecutive identical
  const dedup: string[] = [];
  for (const b of bullets) {
    if (dedup[dedup.length - 1] === b) continue;
    dedup.push(b);
  }
  const text = `# Сжатая история шагов\n${dedup.slice(-40).join("\n")}`;
  return estimateTokens(text) > maxTokens ? truncateToTokens(text, maxTokens) : text;
}

/**
 * When transcript grows past a threshold, fold oldest turns into a summary message
 * and keep only the newest `keepRecent` messages (+ system).
 */
export function condenseTranscript<T extends { role: string; content: string }>(
  transcript: T[],
  opts?: { keepRecent?: number; summaryTokens?: number; triggerMessages?: number },
): T[] {
  const keepRecent = opts?.keepRecent ?? 8;
  const summaryTokens = opts?.summaryTokens ?? 350;
  const trigger = opts?.triggerMessages ?? 14;
  if (transcript.length <= trigger) return transcript;

  const system = transcript[0]?.role === "system" ? transcript[0] : null;
  const rest = system ? transcript.slice(1) : transcript.slice();
  if (rest.length <= keepRecent) return transcript;

  const old = rest.slice(0, rest.length - keepRecent);
  const recent = rest.slice(rest.length - keepRecent);
  const summary = summarizeTranscript(old, summaryTokens);
  if (!summary) return transcript;

  const summaryMsg = {
    role: "user",
    content: summary,
  } as T;

  return system ? [system, summaryMsg, ...recent] : [summaryMsg, ...recent];
}

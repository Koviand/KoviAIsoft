import { v4 as uuid } from "uuid";
import type { ChatMessage, GenerationParams } from "@kovi/shared";
import type { RuntimeManager } from "../runtime/manager.js";
import type { Store } from "../db/store.js";
import { condenseTranscript } from "../context/summarize.js";
import {
  fitMessagesToContext,
  isContextOverflowError,
} from "./contextBudget.js";
import { formatLlmFetchError, pickCompletionText, stripThinkTags } from "./llmErrors.js";

export type TokenHandler = (p: {
  sessionId: string;
  text: string;
  thinking?: boolean;
  /** Agent JSON-step draft tokens (shown as «Вывод модели»). */
  draft?: boolean;
}) => void;

interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  name?: string;
}

export class ChatEngine {
  private runtime: RuntimeManager;
  private store: Store;
  private abort: AbortController | null = null;
  private onToken?: TokenHandler;
  private activeSessionId: string | null = null;

  constructor(runtime: RuntimeManager, store: Store) {
    this.runtime = runtime;
    this.store = store;
  }

  setTokenHandler(fn: TokenHandler): void {
    this.onToken = fn;
  }

  /** Abort in-flight streaming chat or agent JSON completion. */
  stop(): void {
    this.abort?.abort();
    this.abort = null;
  }

  isBusy(): boolean {
    return Boolean(this.abort);
  }

  getActiveSessionId(): string | null {
    return this.activeSessionId;
  }

  async send(
    sessionId: string,
    userContent: string,
    params: GenerationParams,
    systemPrompt: string,
  ): Promise<ChatMessage> {
    let base: string;
    try {
      base = await this.runtime.assertLlmReady();
    } catch (err) {
      throw formatLlmFetchError(err, this.runtime.getOpenAiBaseUrl());
    }

    this.stop();
    this.store.addMessage(sessionId, { role: "user", content: userContent });
    const history = this.store.getMessages(sessionId);
    // Skip orphan tool rows from agent turns — plain chat has no tool_calls protocol.
    const ctx = Math.max(512, params.context || 4096);
    const maxTokens = Math.max(
      64,
      Math.min(params.maxTokens || 1024, Math.floor(ctx * 0.45), 4096),
    );
    const rawMessages: OpenAiMessage[] = [
      { role: "system", content: systemPrompt },
      ...history.flatMap((m): OpenAiMessage[] => {
        if (m.role === "user" || m.role === "assistant") {
          return [{ role: m.role, content: m.content }];
        }
        if (m.role === "tool") {
          return [
            {
              role: "user",
              content: `[результат ${m.toolName || "tool"}]\n${m.content.slice(0, 2500)}`,
            },
          ];
        }
        return [];
      }),
    ];
    // P2-13: fold long chat history before fit (extractive, no extra LLM).
    const condensed = condenseTranscript(rawMessages, {
      keepRecent: 10,
      triggerMessages: 16,
      summaryTokens: Math.min(400, Math.floor(ctx * 0.05)),
    });
    const messages: OpenAiMessage[] = fitMessagesToContext(condensed, ctx, maxTokens);

    this.abort = new AbortController();
    this.activeSessionId = sessionId;
    const signal = this.abort.signal;
    let res: Response;
    try {
      res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({
          model: "local",
          messages,
          temperature: params.temperature,
          top_p: params.topP,
          max_tokens: maxTokens,
          stream: true,
          seed: params.seed ?? undefined,
        }),
      });
    } catch (err) {
      this.abort = null;
      this.activeSessionId = null;
      // Re-probe: if server died mid-flight, clear stale "loaded" state via assert.
      try {
        await this.runtime.assertLlmReady();
      } catch (probeErr) {
        throw formatLlmFetchError(probeErr, base);
      }
      throw formatLlmFetchError(err, base);
    }

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      this.abort = null;
      this.activeSessionId = null;
      if (isContextOverflowError(text) || isContextOverflowError(`Ошибка генерации: ${res.status} ${text}`)) {
        throw formatLlmFetchError(
          new Error(`Ошибка генерации: ${res.status} ${text}`),
          base,
        );
      }
      throw new Error(`Ошибка генерации: ${res.status} ${text}`);
    }

    let content = "";
    let thinking = "";
    let inThink = false;
    let truncated = false;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        if (signal.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n");
        buffer = parts.pop() || "";
        for (const line of parts) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") continue;
          try {
            const json = JSON.parse(data) as {
              choices?: Array<{
                finish_reason?: string | null;
                delta?: { content?: string; reasoning_content?: string };
              }>;
            };
            const finish = json.choices?.[0]?.finish_reason;
            if (finish === "length") truncated = true;
            const delta = json.choices?.[0]?.delta as
              | {
                  content?: string;
                  reasoning_content?: string;
                  reasoning?: string;
                  text?: string;
                }
              | undefined;
            const piece = delta?.content || delta?.text || "";
            const reason = delta?.reasoning_content || delta?.reasoning || "";
            if (reason) {
              thinking += reason;
              this.onToken?.({ sessionId, text: reason, thinking: true });
            }
            if (!piece) continue;
            // Support <think> / <thinking> tags from some models (LFM, Qwen, etc.)
            let rest = piece;
            while (rest.length) {
              if (!inThink) {
                const m = rest.match(/<(?:think|thinking)>/i);
                if (!m || m.index == null) {
                  content += rest;
                  this.onToken?.({ sessionId, text: rest });
                  rest = "";
                } else {
                  const before = rest.slice(0, m.index);
                  if (before) {
                    content += before;
                    this.onToken?.({ sessionId, text: before });
                  }
                  inThink = true;
                  rest = rest.slice(m.index + m[0].length);
                }
              } else {
                const m = rest.match(/<\/(?:think|thinking)>/i);
                if (!m || m.index == null) {
                  thinking += rest;
                  this.onToken?.({ sessionId, text: rest, thinking: true });
                  rest = "";
                } else {
                  const chunk = rest.slice(0, m.index);
                  if (chunk) {
                    thinking += chunk;
                    this.onToken?.({ sessionId, text: chunk, thinking: true });
                  }
                  inThink = false;
                  rest = rest.slice(m.index + m[0].length);
                }
              }
            }
          } catch {
            // ignore bad chunk
          }
        }
      }
    } catch (err) {
      if ((err as Error).name === "AbortError" || signal.aborted) {
        // fall through to cancel path below
      } else {
        this.abort = null;
        this.activeSessionId = null;
        throw err;
      }
    }

    if (signal.aborted) {
      if (content.trim()) {
        this.store.addMessage(sessionId, {
          id: uuid(),
          role: "assistant",
          content: content + "\n\n(остановлено)",
          thinking: thinking || undefined,
        });
      }
      this.abort = null;
      this.activeSessionId = null;
      throw new Error("Отменено");
    }

    let finalContent = content || "(пусто)";
    if (truncated) {
      finalContent +=
        "\n\n⚠️ Ответ обрезан по лимиту max tokens. Увеличьте параметр «Макс. токены» в параметрах диалога или попросите продолжить.";
      this.onToken?.({
        sessionId,
        text: "\n\n⚠️ Ответ обрезан по лимиту max tokens.",
      });
    }
    const assistant = this.store.addMessage(sessionId, {
      id: uuid(),
      role: "assistant",
      content: finalContent,
      thinking: thinking || undefined,
    });
    this.abort = null;
    this.activeSessionId = null;
    return assistant;
  }

  /**
   * Agent JSON completion with live SSE so the UI can show model work-in-progress.
   * Pass sessionId to stream draft tokens via onToken({ draft: true }).
   */
  async completeJson(
    messages: OpenAiMessage[],
    params: GenerationParams,
    sessionId?: string,
  ): Promise<string> {
    let base: string;
    try {
      base = await this.runtime.assertLlmReady();
    } catch (err) {
      throw formatLlmFetchError(err, this.runtime.getOpenAiBaseUrl());
    }

    // Keep completion within context headroom — requesting 8k with ctx 8k hangs/resets Vulkan.
    const ctx = Math.max(512, params.context || 4096);
    const maxTokens = Math.max(
      256,
      Math.min(params.maxTokens || 1024, Math.floor(ctx * 0.45), 4096),
    );

    const attemptOnce = async (
      signal: AbortSignal,
      msgs: OpenAiMessage[],
    ): Promise<string> => {
      const packed = fitMessagesToContext(msgs, ctx, maxTokens);
      let res: Response;
      try {
        res = await fetch(`${base}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal,
          body: JSON.stringify({
            model: "local",
            messages: packed,
            temperature: params.temperature,
            top_p: params.topP,
            max_tokens: maxTokens,
            stream: true,
          }),
        });
      } catch (err) {
        throw formatLlmFetchError(err, base);
      }
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        throw new Error(`Ошибка LLM: ${res.status} ${text}`);
      }

      let content = "";
      let reasoning = "";
      let truncated = false;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        if (signal.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n");
        buffer = parts.pop() || "";
        for (const line of parts) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") continue;
          try {
            const json = JSON.parse(data) as {
              choices?: Array<{
                finish_reason?: string | null;
                delta?: {
                  content?: string;
                  reasoning_content?: string;
                  reasoning?: string;
                  text?: string;
                };
              }>;
            };
            const finish = json.choices?.[0]?.finish_reason;
            if (finish === "length") truncated = true;
            const delta = json.choices?.[0]?.delta;
            // Never mix thinking into JSON content — models often stream reasoning first.
            const reason = delta?.reasoning_content || delta?.reasoning || "";
            if (reason) reasoning += reason;
            const piece = delta?.content || delta?.text || "";
            if (!piece) continue;
            content += piece;
            if (sessionId) {
              this.onToken?.({ sessionId, text: piece, draft: true });
            }
          } catch {
            // ignore bad chunk
          }
        }
      }

      if (signal.aborted) {
        throw new Error("Отменено");
      }
      if (truncated && !content.trim()) {
        throw new Error(
          "Ответ LLM обрезан по max_tokens (finish_reason=length). Упростите шаг: пишите один файл целиком через write_file или увеличьте лимит токенов.",
        );
      }
      // Fallback if server ignored stream and returned empty (rare).
      if (!content.trim()) {
        // Some local models put the whole JSON only in reasoning_content.
        if (reasoning.trim()) {
          content = reasoning;
          if (sessionId) {
            this.onToken?.({ sessionId, text: content, draft: true });
          }
        } else {
          const packed2 = fitMessagesToContext(msgs, ctx, maxTokens);
          const res2 = await fetch(`${base}/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal,
            body: JSON.stringify({
              model: "local",
              messages: packed2,
              temperature: params.temperature,
              top_p: params.topP,
              max_tokens: maxTokens,
              stream: false,
            }),
          });
          if (!res2.ok) {
            const text = await res2.text();
            throw new Error(`Ошибка LLM: ${res2.status} ${text}`);
          }
          const json = (await res2.json()) as {
            choices?: Array<{
              message?: {
                content?: string;
                reasoning_content?: string;
                reasoning?: string;
              };
              finish_reason?: string;
            }>;
          };
          const choice = json.choices?.[0];
          content = pickCompletionText(choice?.message);
          if (choice?.finish_reason === "length" && !content.trim()) {
            throw new Error(
              "Ответ LLM обрезан по max_tokens (finish_reason=length). Упростите шаг: пишите один файл целиком через write_file или увеличьте лимит токенов.",
            );
          }
          if (sessionId && content) {
            this.onToken?.({ sessionId, text: content, draft: true });
          }
        }
      }
      // Strip <think> blocks that some models embed in content (breaks extractJson).
      return stripThinkTags(content);
    };

    // Reuse / replace abort so agent cancel (chat.stop) interrupts JSON calls too.
    this.stop();
    this.abort = new AbortController();
    this.activeSessionId = sessionId || null;
    const signal = this.abort.signal;

    try {
      try {
        return await attemptOnce(signal, messages);
      } catch (err) {
        if (signal.aborted || (err instanceof Error && err.name === "AbortError")) {
          throw err;
        }
        const msg = err instanceof Error ? err.message : String(err);
        if (isContextOverflowError(err)) {
          // Keep system (includes working memory) + last 3 turns — avoid wiping plan/goal.
          const system = messages.find((m) => m.role === "system");
          const rest = messages.filter((m) => m.role !== "system");
          const tail = rest.slice(-3);
          const emergency = system ? [system, ...tail] : tail;
          return await attemptOnce(signal, emergency);
        }
        if (!/fetch failed|econnreset|socket|network/i.test(msg)) {
          throw err;
        }
        await new Promise((r) => setTimeout(r, 750));
        base = await this.runtime.assertLlmReady();
        if (signal.aborted) throw err;
        return await attemptOnce(signal, messages);
      }
    } catch (err) {
      throw formatLlmFetchError(err, base);
    } finally {
      if (this.abort?.signal === signal) {
        this.abort = null;
      }
      if (this.activeSessionId === sessionId) {
        this.activeSessionId = null;
      }
    }
  }
}

import { v4 as uuid } from "uuid";
import type { ChatMessage, GenerationParams } from "@kovi/shared";
import type { RuntimeManager } from "../runtime/manager.js";
import type { Store } from "../db/store.js";

export type TokenHandler = (p: {
  sessionId: string;
  text: string;
  thinking?: boolean;
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
    const base = this.runtime.getOpenAiBaseUrl();
    if (!base) throw new Error("Модель не загружена. Загрузите модель во вкладке Runtime/Models.");

    this.stop();
    this.store.addMessage(sessionId, { role: "user", content: userContent });
    const history = this.store.getMessages(sessionId);
    // Skip orphan tool rows from agent turns — plain chat has no tool_calls protocol.
    const messages: OpenAiMessage[] = [
      { role: "system", content: systemPrompt },
      ...history.flatMap((m): OpenAiMessage[] => {
        if (m.role === "user" || m.role === "assistant") {
          return [{ role: m.role, content: m.content }];
        }
        if (m.role === "tool") {
          return [
            {
              role: "user",
              content: `[результат ${m.toolName || "tool"}]\n${m.content.slice(0, 6000)}`,
            },
          ];
        }
        return [];
      }),
    ];

    this.abort = new AbortController();
    this.activeSessionId = sessionId;
    const signal = this.abort.signal;
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        model: "local",
        messages,
        temperature: params.temperature,
        top_p: params.topP,
        max_tokens: params.maxTokens,
        stream: true,
        seed: params.seed ?? undefined,
      }),
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      this.abort = null;
      this.activeSessionId = null;
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
      if ((err as Error).name === "AbortError") {
        // partial save
      } else {
        this.abort = null;
        this.activeSessionId = null;
        throw err;
      }
    }

    let finalContent = content || (signal.aborted ? "(остановлено)" : "(пусто)");
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

  async completeJson(messages: OpenAiMessage[], params: GenerationParams): Promise<string> {
    const base = this.runtime.getOpenAiBaseUrl();
    if (!base) throw new Error("Модель не загружена");

    // Reuse / replace abort so agent cancel (chat.stop) interrupts JSON calls too.
    this.stop();
    this.abort = new AbortController();
    const signal = this.abort.signal;

    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({
          model: "local",
          messages,
          temperature: params.temperature,
          top_p: params.topP,
          max_tokens: params.maxTokens,
          stream: false,
        }),
      });
      if (!res.ok) {
        throw new Error(`LLM error: ${res.status} ${await res.text()}`);
      }
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return json.choices?.[0]?.message?.content || "";
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new Error("Отменено");
      }
      throw err;
    } finally {
      if (this.abort?.signal === signal) {
        this.abort = null;
      }
    }
  }
}

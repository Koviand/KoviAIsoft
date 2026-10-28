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
    const messages: OpenAiMessage[] = [
      { role: "system", content: systemPrompt },
      ...history
        .filter((m) => m.role !== "system")
        .map((m) => ({
          role: m.role,
          content: m.content,
          tool_call_id: m.toolCallId,
          name: m.toolName,
        })),
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
              choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }>;
            };
            const delta = json.choices?.[0]?.delta;
            const piece = delta?.content || "";
            const reason = delta?.reasoning_content || "";
            if (reason) {
              thinking += reason;
              this.onToken?.({ sessionId, text: reason, thinking: true });
            }
            if (!piece) continue;
            // Support <think> tags from some models
            let rest = piece;
            while (rest.length) {
              if (!inThink) {
                const idx = rest.indexOf("<think>");
                if (idx === -1) {
                  content += rest;
                  this.onToken?.({ sessionId, text: rest });
                  rest = "";
                } else {
                  const before = rest.slice(0, idx);
                  if (before) {
                    content += before;
                    this.onToken?.({ sessionId, text: before });
                  }
                  inThink = true;
                  rest = rest.slice(idx + 7);
                }
              } else {
                const idx = rest.indexOf("</think>");
                if (idx === -1) {
                  thinking += rest;
                  this.onToken?.({ sessionId, text: rest, thinking: true });
                  rest = "";
                } else {
                  thinking += rest.slice(0, idx);
                  this.onToken?.({ sessionId, text: rest.slice(0, idx), thinking: true });
                  inThink = false;
                  rest = rest.slice(idx + 8);
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

    const assistant = this.store.addMessage(sessionId, {
      id: uuid(),
      role: "assistant",
      content: content || (signal.aborted ? "(остановлено)" : "(пусто)"),
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

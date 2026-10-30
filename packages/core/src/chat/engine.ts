import { v4 as uuid } from "uuid";
import type { ChatMessage, GenerationParams } from "@kovi/shared";
import type { RuntimeManager } from "../runtime/manager.js";
import type { Store } from "../db/store.js";
import { condenseTranscript } from "../context/summarize.js";
import { clampCompletionTokens } from "./completionBudget.js";
import {
  fitMessagesToContext,
  isContextOverflowError,
} from "./contextBudget.js";
import {
  buildAgentActionGbnf,
  nextConstraintModeAfterFailure,
  pickConstraintMode,
  responseFormatJsonSchema,
  type ConstraintMode,
} from "../agent/actionSchema.js";
import {
  formatLlmFetchError,
  isLlmTruncatedError,
  LlmTruncatedError,
  pickCompletionText,
  stripThinkTags,
} from "./llmErrors.js";
import {
  AGENT_JSON_SCHEMA_HINT,
  balancedJsonPrefix,
  looksBrokenJson,
  preferBalancedJson,
} from "./jsonStream.js";

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

  getRuntime(): RuntimeManager {
    return this.runtime;
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
    // Cursor-like: allow long replies — honor settings up to ~70% of the window.
    const maxTokens = clampCompletionTokens(ctx, params.maxTokens || 0, {
      min: 64,
      promptReserveRatio: 0.3,
    });
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
    const baseMessages: OpenAiMessage[] = fitMessagesToContext(condensed, ctx, maxTokens);

    this.abort = new AbortController();
    this.activeSessionId = sessionId;
    const signal = this.abort.signal;

    let content = "";
    let thinking = "";
    let truncated = false;
    /** Auto-continue when finish_reason=length (Cursor-like long answers). */
    const maxContinues = 2;

    for (let leg = 0; leg <= maxContinues; leg++) {
      let messages = baseMessages;
      if (leg > 0) {
        if (!content.trim() || signal.aborted) break;
        messages = fitMessagesToContext(
          [
            ...baseMessages,
            { role: "assistant", content },
            {
              role: "user",
              content:
                "Continue exactly from where you left off. Do not repeat previous text. Keep the same language and formatting.",
            },
          ],
          ctx,
          maxTokens,
        );
      }

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
            top_k: params.topK,
            min_p: params.minP,
            max_tokens: maxTokens,
            stream: true,
            seed: params.seed ?? undefined,
          }),
        });
      } catch (err) {
        this.abort = null;
        this.activeSessionId = null;
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
        if (
          isContextOverflowError(text) ||
          isContextOverflowError(`Ошибка генерации: ${res.status} ${text}`)
        ) {
          throw formatLlmFetchError(
            new Error(`Ошибка генерации: ${res.status} ${text}`),
            base,
          );
        }
        throw new Error(`Ошибка генерации: ${res.status} ${text}`);
      }

      let inThink = false;
      truncated = false;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let legContent = "";

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
              let rest = piece;
              while (rest.length) {
                if (!inThink) {
                  const m = rest.match(/<(?:think|thinking)>/i);
                  if (!m || m.index == null) {
                    content += rest;
                    legContent += rest;
                    this.onToken?.({ sessionId, text: rest });
                    rest = "";
                  } else {
                    const before = rest.slice(0, m.index);
                    if (before) {
                      content += before;
                      legContent += before;
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
          // fall through
        } else {
          this.abort = null;
          this.activeSessionId = null;
          throw err;
        }
      }

      if (signal.aborted) break;
      if (!truncated || !legContent.trim()) {
        truncated = false;
        break;
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
        "\n\n⚠️ Ответ всё ещё обрезан по лимиту. Увеличьте «Макс. токены» / context или попросите продолжить.";
      this.onToken?.({
        sessionId,
        text: "\n\n⚠️ Ответ всё ещё обрезан по лимиту.",
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
    opts?: { extraToolNames?: string[] },
  ): Promise<string> {
    let base: string;
    try {
      base = await this.runtime.assertLlmReady();
    } catch (err) {
      throw formatLlmFetchError(err, this.runtime.getOpenAiBaseUrl());
    }

    // Agent JSON may need a large budget (full file bodies). Cap only by context headroom.
    const ctx = Math.max(512, params.context || 4096);
    const hardCap = clampCompletionTokens(ctx, Number.MAX_SAFE_INTEGER, {
      min: 1024,
      promptReserveRatio: 0.25,
      minPromptReserve: 512,
    });
    const requested = Math.max(256, params.maxTokens || 1024);
    let maxTokens = clampCompletionTokens(ctx, requested, {
      min: 256,
      promptReserveRatio: 0.25,
      minPromptReserve: 512,
    });

    const buildBody = (
      packed: OpenAiMessage[],
      tokenBudget: number,
      mode: ConstraintMode,
      stream: boolean,
    ): Record<string, unknown> => {
      const body: Record<string, unknown> = {
        model: "local",
        messages: packed,
        temperature: params.temperature,
        top_p: params.topP,
        top_k: params.topK,
        min_p: params.minP,
        max_tokens: tokenBudget,
        stream,
      };
      if (mode === "json_schema") {
        body.response_format = responseFormatJsonSchema(opts?.extraToolNames || []);
      } else if (mode === "grammar") {
        body.grammar = buildAgentActionGbnf();
      }
      return body;
    };

    const attemptOnce = async (
      signal: AbortSignal,
      msgs: OpenAiMessage[],
      tokenBudget: number,
      mode: ConstraintMode,
    ): Promise<{ content: string; truncated: boolean; mode: ConstraintMode }> => {
      const packed = fitMessagesToContext(msgs, ctx, tokenBudget);
      let res: Response;
      try {
        res = await fetch(`${base}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal,
          body: JSON.stringify(buildBody(packed, tokenBudget, mode, true)),
        });
      } catch (err) {
        throw formatLlmFetchError(err, base);
      }
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        const err = new Error(`Ошибка LLM: ${res.status} ${text}`);
        (err as Error & { status?: number }).status = res.status;
        throw err;
      }

      let content = "";
      let reasoning = "";
      let truncated = false;
      /** Only emit balanced JSON prefixes to the UI (avoid mid-token broken drafts). */
      let draftEmitted = 0;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const emitBalancedDraft = () => {
        if (!sessionId) return;
        const bal = balancedJsonPrefix(content);
        if (bal.length <= draftEmitted) return;
        const deltaText = bal.slice(draftEmitted);
        draftEmitted = bal.length;
        if (deltaText) this.onToken?.({ sessionId, text: deltaText, draft: true });
      };

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
            emitBalancedDraft();
          } catch {
            // ignore bad chunk
          }
        }
      }
      // Final flush: if never balanced, show raw tail once so UI is not empty.
      if (sessionId && draftEmitted === 0 && content.trim()) {
        this.onToken?.({ sessionId, text: content, draft: true });
        draftEmitted = content.length;
      } else if (sessionId && content.length > draftEmitted) {
        // Prefer balanced; if incomplete, still show remainder after stream ends.
        this.onToken?.({
          sessionId,
          text: content.slice(draftEmitted),
          draft: true,
        });
      }

      if (signal.aborted) {
        throw new Error("Отменено");
      }
      // Fallback if stream content empty — try reasoning, then non-stream once.
      if (!content.trim()) {
        if (reasoning.trim()) {
          content = reasoning;
          if (sessionId) {
            this.onToken?.({ sessionId, text: content, draft: true });
          }
        } else {
          const packed2 = fitMessagesToContext(msgs, ctx, tokenBudget);
          const res2 = await fetch(`${base}/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal,
            body: JSON.stringify(buildBody(packed2, tokenBudget, mode, false)),
          });
          if (!res2.ok) {
            const text = await res2.text();
            const err = new Error(`Ошибка LLM: ${res2.status} ${text}`);
            (err as Error & { status?: number }).status = res2.status;
            throw err;
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
          if (choice?.finish_reason === "length") truncated = true;
          if (sessionId && content) {
            this.onToken?.({ sessionId, text: content, draft: true });
          }
        }
      }
      const cleaned = preferBalancedJson(stripThinkTags(content));
      // Do not throw here — caller boosts max_tokens first, then may throw.
      return { content: cleaned, truncated, mode };
    };

    const markConstraintFailure = (mode: ConstraintMode): void => {
      if (mode === "json_schema") this.runtime.jsonSchemaOk = false;
      if (mode === "grammar") this.runtime.grammarOk = false;
    };

    const markConstraintSuccess = (mode: ConstraintMode): void => {
      if (mode === "json_schema") this.runtime.jsonSchemaOk = true;
      if (mode === "grammar") this.runtime.grammarOk = true;
    };

    const isConstraintReject = (err: unknown): boolean => {
      const status = (err as { status?: number })?.status;
      if (status === 400 || status === 422) return true;
      const msg = err instanceof Error ? err.message : String(err);
      return /json_schema|response_format|grammar|unknown field|invalid.*schema/i.test(msg);
    };

    const resolveAttempt = async (
      signal: AbortSignal,
      msgs: OpenAiMessage[],
    ): Promise<string> => {
      let mode = pickConstraintMode({
        jsonSchemaOk: this.runtime.jsonSchemaOk,
        grammarOk: this.runtime.grammarOk,
      });

      const runWithMode = async (m: ConstraintMode) => {
        let attemptMsgs = msgs;
        let result = await attemptOnce(signal, attemptMsgs, maxTokens, m);
        // Boost before failing — truncated JSON is common on large write_file turns.
        let boosts = 0;
        while (
          result.truncated &&
          boosts < 2 &&
          (looksBrokenJson(result.content) || !result.content.trim())
        ) {
          const boosted = Math.min(
            hardCap,
            Math.max(maxTokens + 2048, Math.floor(ctx * 0.65)),
          );
          if (boosted <= maxTokens) break;
          maxTokens = boosted;
          boosts += 1;
          // One short schema nudge on first boost (helps small GGUF).
          if (boosts === 1) {
            attemptMsgs = [
              ...msgs,
              { role: "user", content: AGENT_JSON_SCHEMA_HINT },
            ];
          }
          result = await attemptOnce(signal, attemptMsgs, maxTokens, m);
        }
        if (result.truncated && !result.content.trim()) {
          throw new LlmTruncatedError();
        }
        if (result.truncated && looksBrokenJson(result.content)) {
          throw new LlmTruncatedError();
        }
        return result;
      };

      // Walk json_schema → grammar → none on 4xx / unsupported.
      for (;;) {
        try {
          const result = await runWithMode(mode);
          markConstraintSuccess(mode);
          return result.content;
        } catch (err) {
          if (signal.aborted || (err instanceof Error && err.name === "AbortError")) {
            throw err;
          }
          if (isLlmTruncatedError(err)) throw err;
          if (!isConstraintReject(err)) throw err;
          markConstraintFailure(mode);
          const next = nextConstraintModeAfterFailure(mode);
          if (!next) throw err;
          mode = next;
        }
      }
    };

    // Reuse / replace abort so agent cancel (chat.stop) interrupts JSON calls too.
    this.stop();
    this.abort = new AbortController();
    this.activeSessionId = sessionId || null;
    const signal = this.abort.signal;

    try {
      try {
        return await resolveAttempt(signal, messages);
      } catch (err) {
        if (signal.aborted || (err instanceof Error && err.name === "AbortError")) {
          throw err;
        }
        if (isLlmTruncatedError(err)) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        if (isContextOverflowError(err)) {
          // Keep system (includes working memory) + last 3 turns — avoid wiping plan/goal.
          const system = messages.find((m) => m.role === "system");
          const rest = messages.filter((m) => m.role !== "system");
          const tail = rest.slice(-3);
          const emergency = system ? [system, ...tail] : tail;
          return await resolveAttempt(signal, emergency);
        }
        if (!/fetch failed|econnreset|socket|network/i.test(msg)) {
          throw err;
        }
        await new Promise((r) => setTimeout(r, 750));
        base = await this.runtime.assertLlmReady();
        if (signal.aborted) throw err;
        return await resolveAttempt(signal, messages);
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

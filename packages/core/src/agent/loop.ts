import { v4 as uuid } from "uuid";
import type {
  AgentConfirmation,
  AgentEvent,
  AgentPlanStep,
  AppSettings,
  GenerationParams,
} from "@kovi/shared";
import type { ChatEngine } from "../chat/engine.js";
import type { Store } from "../db/store.js";
import type { McpManager } from "../mcp/manager.js";
import { BrowserTooling } from "../tools/browser.js";
import {
  applyPatchTool,
  deletePathTool,
  listDir,
  readFileTool,
  runTerminal,
  searchFiles,
  writeFileTool,
} from "../tools/files.js";
import { riskForTool } from "../tools/sandbox.js";
import { webSearch } from "../tools/websearch.js";
import { toolsPromptBlock } from "./toolsCatalog.js";

type EventFn = (sessionId: string, event: AgentEvent) => void;

interface ParsedAction {
  thought?: string;
  plan?: Array<{ id: string; title: string }>;
  tool?: { name: string; args?: Record<string, unknown> } | null;
  final?: string | null;
}

function extractJson(text: string): ParsedAction | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fence?.[1] || text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as ParsedAction;
  } catch {
    return null;
  }
}

export class AgentLoop {
  private chat: ChatEngine;
  private store: Store;
  private mcp: McpManager;
  private browser = new BrowserTooling();
  private onEvent?: EventFn;
  private cancelled = false;
  private pendingConfirm = new Map<
    string,
    {
      resolve: (approved: boolean) => void;
      toolName: string;
      sessionId: string;
    }
  >();
  /** Remembered tool approvals keyed by chat session (survive multiple agent turns). */
  private allowBySession = new Map<string, Set<string>>();
  private running = false;

  constructor(chat: ChatEngine, store: Store, mcp: McpManager) {
    this.chat = chat;
    this.store = store;
    this.mcp = mcp;
  }

  setEventHandler(fn: EventFn): void {
    this.onEvent = fn;
  }

  cancel(): void {
    this.cancelled = true;
    // Interrupt in-flight LLM JSON completion used by the agent loop.
    this.chat.stop();
    for (const [id, p] of this.pendingConfirm) {
      p.resolve(false);
      this.pendingConfirm.delete(id);
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  resolveConfirmation(id: string, approved: boolean, remember = false): void {
    const pending = this.pendingConfirm.get(id);
    if (!pending) return;
    if (approved && remember && pending.sessionId) {
      this.allowFor(pending.sessionId).add(pending.toolName);
    }
    pending.resolve(approved);
    this.pendingConfirm.delete(id);
  }

  private allowFor(sessionId: string): Set<string> {
    let set = this.allowBySession.get(sessionId);
    if (!set) {
      set = new Set();
      this.allowBySession.set(sessionId, set);
    }
    return set;
  }

  /** Drop remembered approvals when a session is deleted. */
  clearSessionAllow(sessionId: string): void {
    this.allowBySession.delete(sessionId);
  }

  private emit(sessionId: string, event: AgentEvent): void {
    this.onEvent?.(sessionId, event);
  }

  private async confirmIfNeeded(
    sessionId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<boolean> {
    const risk = riskForTool(toolName, args);
    if (risk === "low") return true;
    if (this.allowFor(sessionId).has(toolName)) return true;
    const confirmation: AgentConfirmation = {
      id: uuid(),
      toolName,
      summary: `${toolName} ${JSON.stringify(args).slice(0, 240)}`,
      args,
      risk: risk === "high" ? "high" : "medium",
      createdAt: new Date().toISOString(),
    };
    this.emit(sessionId, { type: "confirmation_required", confirmation });
    return new Promise<boolean>((resolve) => {
      this.pendingConfirm.set(confirmation.id, { resolve, toolName, sessionId });
    });
  }

  private async execTool(
    name: string,
    args: Record<string, unknown>,
    settings: AppSettings,
  ): Promise<string> {
    switch (name) {
      case "list_dir":
        return listDir(String(args.path), settings);
      case "read_file":
        return readFileTool(String(args.path), settings);
      case "write_file":
        return writeFileTool(String(args.path), String(args.content ?? ""), settings);
      case "apply_patch":
        return applyPatchTool(
          String(args.path),
          String(args.oldText ?? ""),
          String(args.newText ?? ""),
          settings,
        );
      case "delete_path":
        return deletePathTool(String(args.path), settings);
      case "search":
        return searchFiles(String(args.query), String(args.path), settings);
      case "run_terminal":
        return runTerminal(String(args.command), String(args.cwd), settings);
      case "web_search":
        return webSearch(String(args.query), settings);
      case "browser_navigate":
        return this.browser.navigate(String(args.url));
      case "browser_snapshot":
        return this.browser.snapshot();
      case "browser_click":
        return this.browser.click(String(args.selector));
      case "browser_type":
        return this.browser.type(String(args.selector), String(args.text ?? ""));
      case "finish":
        return String(args.summary ?? "");
      default:
        if (name.startsWith("mcp_")) {
          return this.mcp.callTool(name, args);
        }
        throw new Error(`Неизвестный инструмент: ${name}`);
    }
  }

  async run(
    sessionId: string,
    userContent: string,
    settings: AppSettings,
    params: GenerationParams,
    systemPrompt: string,
  ): Promise<void> {
    if (this.running) throw new Error("Агент уже выполняется");
    this.running = true;
    this.cancelled = false;

    try {
      this.store.addMessage(sessionId, { role: "user", content: userContent });
      const projectHint =
        settings.fileAccessMode === "project"
          ? `Режим доступа: project. Корень: ${settings.projectRoot || "(не задан)"}`
          : `Режим доступа: disk. Будь осторожен с записью/удалением.`;

      const toolBlock = toolsPromptBlock(
        this.mcp.listTools().map((t) => ({ name: t.name, description: t.description })),
      );

      const transcript: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
        {
          role: "system",
          content: `${systemPrompt}\n\n${projectHint}\n\n${toolBlock}`,
        },
      ];

      // Include prior chat history so multi-turn agent runs keep context.
      const prior = this.store.getMessages(sessionId);
      for (const m of prior) {
        if (m.role === "system") continue;
        if (m.role === "tool") {
          transcript.push({
            role: "user",
            content: `Результат инструмента ${m.toolName || "tool"}:\n${m.content.slice(0, 6000)}`,
          });
          continue;
        }
        if (m.role === "user" || m.role === "assistant") {
          transcript.push({ role: m.role, content: m.content });
        }
      }

      let steps: AgentPlanStep[] = [];

      for (let i = 0; i < settings.agentMaxSteps; i++) {
        if (this.cancelled) {
          this.emit(sessionId, { type: "cancelled" });
          return;
        }

        let raw: string;
        try {
          raw = await this.chat.completeJson(transcript, {
            ...params,
            temperature: Math.min(params.temperature, 0.4),
          });
        } catch (err) {
          if (this.cancelled || (err instanceof Error && /отмен/i.test(err.message))) {
            this.emit(sessionId, { type: "cancelled" });
            return;
          }
          throw err;
        }
        if (this.cancelled) {
          this.emit(sessionId, { type: "cancelled" });
          return;
        }

        const parsed = extractJson(raw);
        if (!parsed) {
          transcript.push({ role: "assistant", content: raw });
          transcript.push({
            role: "user",
            content: "Ответ не JSON. Верни строго JSON по схеме.",
          });
          continue;
        }

        if (parsed.thought) {
          this.emit(sessionId, { type: "thinking", text: parsed.thought });
        }

        if (parsed.plan?.length) {
          steps = parsed.plan.map((p) => ({
            id: p.id,
            title: p.title,
            status: "pending" as const,
          }));
          this.emit(sessionId, { type: "plan", steps });
        }

        if (parsed.final && !parsed.tool) {
          const msg = this.store.addMessage(sessionId, {
            role: "assistant",
            content: parsed.final,
            thinking: parsed.thought,
          });
          this.emit(sessionId, { type: "token", text: parsed.final });
          this.emit(sessionId, { type: "done", messageId: msg.id });
          return;
        }

        if (!parsed.tool?.name) {
          transcript.push({ role: "assistant", content: JSON.stringify(parsed) });
          transcript.push({
            role: "user",
            content: "Нужен tool или final. Продолжай.",
          });
          continue;
        }

        const toolName = parsed.tool.name;
        const args = parsed.tool.args || {};
        const callId = uuid();
        this.emit(sessionId, { type: "tool_call", name: toolName, args, callId });

        if (toolName === "finish") {
          const summary = String(args.summary || parsed.final || "Готово");
          const msg = this.store.addMessage(sessionId, {
            role: "assistant",
            content: summary,
            thinking: parsed.thought,
          });
          this.emit(sessionId, {
            type: "tool_result",
            callId,
            result: summary,
          });
          this.emit(sessionId, { type: "done", messageId: msg.id });
          return;
        }

        const approved = await this.confirmIfNeeded(sessionId, toolName, args);
        if (this.cancelled) {
          this.emit(sessionId, { type: "cancelled" });
          return;
        }
        if (!approved) {
          const deny = "Пользователь отклонил действие";
          this.emit(sessionId, { type: "tool_result", callId, result: deny, isError: true });
          transcript.push({ role: "assistant", content: JSON.stringify(parsed) });
          transcript.push({ role: "user", content: `Результат инструмента ${toolName}: ${deny}` });
          continue;
        }

        try {
          const result = await this.execTool(toolName, args, settings);
          this.store.addMessage(sessionId, {
            role: "tool",
            content: result,
            toolCallId: callId,
            toolName,
          });
          this.emit(sessionId, { type: "tool_result", callId, result });
          transcript.push({ role: "assistant", content: JSON.stringify(parsed) });
          transcript.push({
            role: "user",
            content: `Результат инструмента ${toolName}:\n${result.slice(0, 12000)}`,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.emit(sessionId, {
            type: "tool_result",
            callId,
            result: message,
            isError: true,
          });
          transcript.push({ role: "assistant", content: JSON.stringify(parsed) });
          transcript.push({
            role: "user",
            content: `Ошибка инструмента ${toolName}: ${message}`,
          });
        }
      }

      const msg = this.store.addMessage(sessionId, {
        role: "assistant",
        content: "Достигнут лимит шагов агента. Уточните задачу или увеличьте лимит в настройках.",
      });
      this.emit(sessionId, { type: "done", messageId: msg.id });
    } catch (err) {
      this.emit(sessionId, {
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.running = false;
    }
  }

  async dispose(): Promise<void> {
    await this.browser.close();
  }
}

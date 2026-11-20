import * as acp from "@agentclientprotocol/sdk"
import type { SessionUpdate } from "@agentclientprotocol/sdk"
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { ImageContent, TextContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai";
import type { Conversation, Harness } from "@earendil-works/pi-durable";
import { AssistantEntry } from "@earendil-works/pi-durable";

import { Readable, Writable } from "node:stream";
import { describeError, log } from "./log.js";

interface AgentSession {
  pendingPrompt: AbortController | null;
  conversation: Conversation;
}

type AssistantContent =
  | string
  | TextContent[]
  | (TextContent | ImageContent)[]
  | (TextContent | ThinkingContent | ToolCall)[]
  | undefined;

export class AcpAgent {
  private sessions: Map<string, AgentSession>;
  private harness: Harness;
  private context: Context;

  constructor(harness: Harness, context = BACKGROUND_CONTEXT) {
    this.sessions = new Map();
    this.harness = harness;
    this.context = context;
  }

  initialize(_params: acp.InitializeRequest): acp.InitializeResponse {
    log.info("request received", { method: "initialize" });
    const response: acp.InitializeResponse = {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
      },
      agentInfo: {
        name: "PAL",
        version: "0.1.0"
      }
    };
    log.debug("response sent", { method: "initialize", bytes: JSON.stringify(response).length });
    return response;
  }

  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    log.info("request received", { method: "session/new", cwd: params.cwd });

    const sessionId = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    let conversation: Conversation;
    try {
      conversation = await this.harness.root(this.context, {
        agent: {
          // model: { provider: "lmstudio", modelId: "qwen/qwen3.8-27b" },
          cwd: params.cwd
        }
      });
    } catch (err) {
      log.error("session/new failed", { method: "session/new", sessionId, err: describeError(err) });
      throw err;
    }

    this.sessions.set(sessionId, {
      pendingPrompt: null,
      conversation
    });
    log.info("session created", { method: "session/new", sessionId, conversation: conversation.id });

    const response: acp.NewSessionResponse = { sessionId };
    log.debug("response sent", { method: "session/new", sessionId, bytes: JSON.stringify(response).length });
    return response;
  }

  async prompt(
    params: acp.PromptRequest,
    cx: acp.AgentContext
  ): Promise<acp.PromptResponse> {
    log.info("request received", {
      method: "session/prompt",
      sessionId: params.sessionId,
      blocks: params.prompt.length
    });

    const session = this.sessions.get(params.sessionId);

    if (!session) {
      log.error("prompt rejected", { method: "session/prompt", sessionId: params.sessionId, reason: "unknown session" });
      throw acp.RequestError.invalidParams(params.sessionId, "Session not found");
    }

    if (session.pendingPrompt) {
      log.warn("superseding in-flight prompt", { method: "session/prompt", sessionId: params.sessionId });
      session.pendingPrompt.abort();
    }
    const controller = new AbortController();
    session.pendingPrompt = controller;

    try {

      const submission = await session.conversation.submit({
        type: "input",
        content: params.prompt.map((cb) => this.toInternalContentBlock(params.sessionId, cb))
      }, this.context);
      log.debug("submission admitted", { method: "session/prompt", sessionId: params.sessionId, submission: submission.id });

      const settled = await submission.wait(this.context);
      log.info("submission settled", {
        method: "session/prompt",
        sessionId: params.sessionId,
        submission: settled.id,
        type: settled.type,
        status: settled.status,
        ...(settled.status === "unanswered" ? { reason: settled.reason } : {})
      });
      if (settled.type === "input" && settled.status === "done") {
        const answer = await session.conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), this.context);

        await this.handleModelResponse(params.sessionId, cx, answer?.model?.[0]?.content);
      }
    } catch (err) {
      // Check the controller this prompt installed, not session.pendingPrompt:
      // a superseding prompt may have replaced it by now.
      if (controller.signal.aborted) {
        // Cancelled (client cancel or supersession) — a clean stop, not a failure.
        log.warn("prompt cancelled", { method: "session/prompt", sessionId: params.sessionId, err: describeError(err) });
      } else {
        log.error("prompt failed", { method: "session/prompt", sessionId: params.sessionId, err: describeError(err) });
      }

      throw err;
    }

    // Only clear if we're still the pending prompt — a superseding prompt
    // may have installed its own controller by now.
    if (session.pendingPrompt === controller) {
      session.pendingPrompt = null;
    }

    const response: acp.PromptResponse = { stopReason: "end_turn" };
    log.debug("response sent", {
      method: "session/prompt",
      sessionId: params.sessionId,
      stopReason: response.stopReason,
      bytes: JSON.stringify(response).length
    });
    return response;
  }

  cancelSession(params: acp.CancelNotification): void {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      log.warn("cancel for unknown session", { method: "session/cancel", sessionId: params.sessionId });
      return;
    }
    if (session.pendingPrompt) {
      log.info("prompt cancelled", { method: "session/cancel", sessionId: params.sessionId });
      session.pendingPrompt.abort();
    } else {
      log.debug("cancel (no in-flight prompt)", { method: "session/cancel", sessionId: params.sessionId });
    }
  }

  private async handleModelResponse(sessionId: string, cx: acp.AgentContext, content: AssistantContent): Promise<void> {
    if (content === undefined) {
      this.handleUndefined(sessionId, cx);
      return;
    }
    if (typeof content === "string") {
      await this.handleString(sessionId, cx, content);
      return;
    }

    log.debug("assistant content", { sessionId, blocks: content.length });

    for (const block of content) {
      switch (block.type) {
        case "text":
          await this.handleText(sessionId, cx, block);
          break;
        case "image":
          this.handleImage(sessionId, cx, block);
          break;
        case "thinking":
          await this.handleThinking(sessionId, cx, block);
          break;
        case "toolCall":
          this.handleToolCall(sessionId, cx, block);
          break;
      }
    }
  }

  private handleUndefined(sessionId: string, _cx: acp.AgentContext): void {
    // A response with no content at all — surface it instead of a silent empty turn.
    log.warn("empty assistant turn (no content)", { sessionId, reason: "content undefined" });
  }

  private async handleString(sessionId: string, cx: acp.AgentContext, content: string): Promise<void> {
    await this.sendUpdate(cx, sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: content
      }
    });
  }

  private async handleText(sessionId: string, cx: acp.AgentContext, content: TextContent): Promise<void> {
    await this.sendUpdate(cx, sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: content.text
      }
    });
  }

  private handleImage(sessionId: string, _cx: acp.AgentContext, content: ImageContent): void {
    // todo
    log.warn("image block not implemented (dropped)", { sessionId, mimeType: content.mimeType });
  }

  private async handleThinking(sessionId: string, cx: acp.AgentContext, content: ThinkingContent): Promise<void> {
    if (!content?.thinking) {
      log.debug("thinking block skipped (empty)", { sessionId });
      return;
    }
    await this.sendUpdate(cx, sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: content.thinking
      }
    });
  }

  private handleToolCall(sessionId: string, _cx: acp.AgentContext, _content: ToolCall): void {
    // todo
    log.warn("tool call block not implemented (dropped)", { sessionId });
  }

  /** Send a session/update notification and log its size (stdout is the protocol channel). */
  private async sendUpdate(cx: acp.AgentContext, sessionId: string, update: SessionUpdate): Promise<void> {
    const notification = { sessionId, update };
    await cx.notify(acp.methods.client.session.update, notification);
    log.debug("update sent", { sessionId, kind: update.sessionUpdate, bytes: JSON.stringify(notification).length });
  }

  private toInternalContentBlock(sessionId: string, cb: acp.ContentBlock): TextContent | ImageContent {
    if (cb.type === "text") {
      return {
        type: "text",
        text: cb.text,
      }
    } else if (cb.type === "image") {
      return {
        type: "image",
        data: cb.data,
        mimeType: cb.mimeType
      }
    } else if (cb.type === "resource_link") {
      return {
        type: "text",
        text: `Resource link: ${cb.uri}`
      }
    } else {
      log.warn("unknown content block from client", { sessionId, type: cb.type });
      return {
        type: "text",
        text: `Unknown content type from ACP bridge: ${cb.type}`,
      }
    }
  }
}

export function attachAcpAgent(harness: Harness, context: Context) {
  log.info("attaching ACP agent", { transport: "stdio" });
  const input = Writable.toWeb(process.stdout);
  const output = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;

  const stream = acp.ndJsonStream(input, output);
  const agent = new AcpAgent(harness, context);
  acp.agent({ name: "PAL" })
    .onRequest("initialize", (ctx) => agent.initialize(ctx.params))
    .onRequest("session/new", (ctx) => agent.newSession(ctx.params))
    .onRequest("session/prompt", (ctx) => agent.prompt(ctx.params, ctx.client))
    .onNotification("session/cancel", (ctx) => agent.cancelSession(ctx.params))
    .connect(stream);
  log.info("ACP agent ready", { transport: "stdio" });
}

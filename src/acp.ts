import * as acp from "@agentclientprotocol/sdk"
import type { SessionUpdate } from "@agentclientprotocol/sdk"
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, ImageContent, TextContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai";
import type { Conversation, Harness, Submission, UserInput } from "@earendil-works/pi-durable";
import { AssistantEntry } from "@earendil-works/pi-durable";

import { Readable, Writable } from "node:stream";

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

  async initialize(_params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
      },
      agentInfo: {
        name: "PAL",
        version: "0.1.0"
      }
    }
  }

  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const sessionId = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const conversation = await this.harness.root(this.context, {
      agent: {
        // model: { provider: "lmstudio", modelId: "qwen/qwen3.8-27b" },
        cwd: params.cwd
      }
    });

    this.sessions.set(sessionId, {
      pendingPrompt: null,
      conversation
    });

    return {
      sessionId,
    };
  }

  async prompt(
    params: acp.PromptRequest,
    cx: acp.AgentContext
  ): Promise<acp.PromptResponse> {
    const session = this.sessions.get(params.sessionId);

    if (!session) {
      throw acp.RequestError.invalidParams(params.sessionId, "Session not found");
    }

    session.pendingPrompt?.abort();
    session.pendingPrompt = new AbortController();

    try {

      const submission = await session.conversation.submit({
        type: "input",
        content: params.prompt.map((cb) => this.toInternalContentBlock(cb))
      }, this.context);

      const settled = await submission.wait(this.context);
      if (settled.type === "input" && settled.status === "done") {
        const answer = await session.conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), this.context);

        await this.handleModelResponse(params.sessionId, cx, answer?.model?.[0]?.content);
      }
    } catch (err) {
      if (session.pendingPrompt.signal.aborted) {
        // do something special here to mark a timeout
      }

      throw err;
    }

    session.pendingPrompt = null;

    return {
      stopReason: "end_turn"
    }
  }

  async cancelSession(params: acp.CancelNotification): Promise<void> {
    this.sessions.get(params.sessionId)?.pendingPrompt?.abort();
  }

  private async handleModelResponse(sessionId: string, cx: acp.AgentContext, content: AssistantContent): Promise<void> {
    if (content === undefined) {
      await this.handleUndefined(sessionId, cx);
      return;
    }
    if (typeof content === "string") {
      await this.handleString(sessionId, cx, content);
      return;
    }

    for (const block of content) {
      switch (block.type) {
        case "text":
          await this.handleText(sessionId, cx, block);
          break;
        case "image":
          await this.handleImage(sessionId, cx, block);
          break;
        case "thinking":
          await this.handleThinking(sessionId, cx, block);
          break;
        case "toolCall":
          await this.handleToolCall(sessionId, cx, block);
          break;
      }
    }
  }

  private async handleUndefined(_sessionId: string, _cx: acp.AgentContext): Promise<void> {

  }

  private async handleString(sessionId: string, cx: acp.AgentContext, content: string): Promise<void> {
    cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: content
        }
      }
    });
  }

  private async handleText(sessionId: string, cx: acp.AgentContext, content: TextContent): Promise<void> {
    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: content.text
        }
      }
    });
    return;
  }

  private async handleImage(_sessionId: string, _cx: acp.AgentContext, _content: ImageContent): Promise<void> {
    // todo
    return;
  }

  private async handleThinking(sessionId: string, cx: acp.AgentContext, content: ThinkingContent): Promise<void> {
    if (!content?.thinking) return;
    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: content.thinking
        }
      }
    });
  }

  private async handleToolCall(sessionId: string, cx: acp.AgentContext, content: ToolCall): Promise<void> {
    // todo
    return;
  }

  private toInternalContentBlock(cb: acp.ContentBlock): TextContent | ImageContent {
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
      const uri = (cb as any).uri ?? (cb as any).url ?? "";
      return {
        type: "text",
        text: `Resource link: ${uri}`
      }
    } else {
      return {
        type: "text",
        text: `Unknown content type from ACP bridge: ${cb.type}`,
      }
    }
  }
}

export function attachAcpAgent(harness: Harness, context: Context) {
  const input = Writable.toWeb(process.stdout);
  const output = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;

  const stream = acp.ndJsonStream(input, output);
  const agent = new AcpAgent(harness, context);
  acp.agent({ name: "PAL" })
    .onRequest("initialize", (ctx) => agent.initialize(ctx.params))
    .onRequest("session/new", (ctx) => agent.newSession(ctx.params))
    .onRequest("session/prompt", (ctx) => agent.prompt(ctx.params, ctx.client))
    .onNotification("session/cancel", (ctx) => agent.cancelSession(ctx.params))
    .connect(stream)
}

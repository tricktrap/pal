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

    let submissionId;
    try {

      const submission = await session.conversation.submit({
        type: "input",
        content: params.prompt.map((cb) => this.toInternalContentBlock(cb))
      }, this.context);

      const settled = await submission.wait(this.context);
      if (settled.type === "input" && settled.status === "done") {
        const answer = await session.conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), this.context);

        await this.handleModelResponse(cx, answer?.model?.[0]?.content);
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

  private async handleModelResponse(cx: acp.AgentContext, content: AssistantContent): Promise<void> {
    if (content === undefined) {
      return this.handleUndefined(cx);
    }
    if (typeof content === "string") {
      return this.handleString(cx, content);
    }

    for (const block of content) {
      switch (block.type) {
        case "text": return this.handleText(cx, block);
        case "image": return this.handleImage(cx, block);
        case "thinking": return this.handleThinking(cx, block);
        case "toolCall": return this.handleToolCall(cx, block);
      }
    }
  }

  private async handleUndefined(cx: acp.AgentContext): Promise<void> {
    // meh
  }

  private async handleString(cx: acp.AgentContext, content: string): Promise<void> {
    return;
  }

  private async handleText(cx: acp.AgentContext, content: TextContent): Promise<void> {
    cx.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content:
      }
    });
    return;
  }

  private async handleImage(cx: acp.AgentContext, content: ImageContent): Promise<void> {
    return;
  }

  private async handleThinking(cx: acp.AgentContext, content: ThinkingContent): Promise<void> {
    return;
  }

  private async handleToolCall(cx: acp.AgentContext, content: ToolCall): Promise<void> {
    return;
  }



  private toAcpMessage(messages: AssistantMessage[]): SessionUpdate {
    return {
      sessionUpdate: "agent_message_chunk",
      content: messages?.[0]?.content.map((content) => { return this.toAcpContentBlock(content) })
    }
  }

  private toAcpContentBlock(content:
    string | (TextContent | ImageContent)[] | TextContent[] | (TextContent | ThinkingContent | ToolCall)[] | undefined): acp.ContentBlock {
    if (!content) {
      return {
        type: "text",
        text: "undefined output"
      };
    }

    if (typeof content === "string") {
      return {
        type: "text",
        text: content
      };
    }


    switch (content.type) {
      case "text":
        return {
          type: "text",
          text: content.text
        }
      case "thinking":
        return {
          type: "text",
          text: content.thinking
        }
      case "toolCall":
        return {
          type: "text",
          text: `tool call: ${content.name}`
        }
      default:
        return {
          type: "text",
          text: "unknown content"
        }
    }
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

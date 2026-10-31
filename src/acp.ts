import * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable"
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { Conversation, Harness, Submission, UserInput } from "@earendil-works/pi-durable";
import { AssistantEntry } from "@earendil-works/pi-durable";

import { Readable, Writable } from "node:stream";

interface AgentSession {
  pendingPrompt: AbortController | null;
  conversation: Conversation;
}

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
      capabilities: {
      },
      info: {
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

      submission.wait(this.context).then((response) => {
        if (response.type === "input" && response.status === "done") {
          session.conversation.commit((tx) => tx.entry(AssistantEntry, response.answer), this.context).then((answer) => {
            cx.notify(acp.CLIENT_METHODS.session_update, {
              sessionId: params.sessionId,
              update: {
                sessionUpdate: "agent_message",
                messageId: answer?.id.toString(),
              }
            }).catch((err) => {
              console.error(err);
            })
          }).catch((err) => {
            console.error(err);
          })
        }
      }).catch((err) => {
      })

      submissionId = submission.id;


    } catch (err) {
      if (session.pendingPrompt.signal.aborted) {
        // do something special here to mark a timeout
      }

      throw err;
    }

    session.pendingPrompt = null;

    return {
      messageId: submissionId.toString()
    }
  }

  async cancelSession(params: acp.CancelSessionNotification): Promise<void> {
    this.sessions.get(params.sessionId)?.pendingPrompt?.abort();
  }

  private toInternalContentBlock(cb: acp.ContentBlock): TextContent | ImageContent {
    if (acp.ContentBlock.isText(cb)) {
      return {
        type: "text",
        text: cb.text,
      }
    } else if (acp.ContentBlock.isImage(cb)) {
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

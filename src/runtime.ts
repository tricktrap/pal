import { createRegistry, Harness, defineTool, defineExtension } from "@earendil-works/pi-durable";
import { type Context } from "@earendil-works/chord"
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { obj, str } from "@earendil-works/pi-schema";


import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { getLMStudioModels } from "./lmstudio.js";
import { log } from "./log.js";

const handoff = defineTool({
  name: "handoff",
  description:
    "Start over from a handoff note. " +
    "Older messages stay serchable with search_history.",
  parameters: obj({ note: str() }),
  execute: async(args, api, context) => {
    // Queued behind the handoff, so it starts the next run in the new context.
    const self = await api.conversation(api.conversationId, context);

    await self!.submit(
      {
        type: "input",
        content: "Continue.",
        requestId: `handoff:${api.taskId}`
      },
      context,
    );
    // Ends this run and starts a new context from the note, like reset(note).
    return {
      content: [{ type: "text", text: "Handing off."}],
      control: { handoff: args.note },
    };
  },
});

const searchHistory = defineTool({
  name: "search_history",
  description: "Search older messages, including those before a handoff",
  parameters: obj({ text: str() }),
  replay: "safe",
  execute: async (args, api, context) => {
    // Tools read records through a transaction too. One that writes
    // nothing stores nothing.
    const page = await api.commit(
      (tx) => tx.scanEntries({ conversationId: api.conversationId }, 200),
      context
    );

    const hits = page.items.filter((entry) => JSON.stringify(entry.model ?? []).includes(args.text));
    const text = hits.map((entry) => JSON.stringify(entry.model)).join("\n");
    return { content: [{ type: "text", text }] };
  }
});

const History = defineExtension({
  name: "history",
  tools: [handoff, searchHistory]
});

export async function initializeHarness(context: Context): Promise<Harness> {
  log.debug("initializing harness", { storage: "./agent.sqlite" });
  const models = await getLMStudioModels();
  const env = ({ cwd }: { cwd?: string }) =>
    new NodeExecutionEnv({ cwd: cwd ?? process.cwd() });

  const registry = createRegistry();
  registry.install(CodingTools); // read, write, edit, bash
  registry.install(History);

  const harness = Harness.open(
    await openNodeSqliteStorage("./agent.sqlite"),
    {
      models,
      registry,
      env,
      settings: {
        compaction: {
          // past contextWindow - reserveTokens, the next request waits for a summary
          reserveTokens: 16384,
          // this far before that, a summary starts in the background
          backgroundTokens: 32768
        }
      }
    },
    context,

  );
  log.debug("harness ready");
  return harness;
}

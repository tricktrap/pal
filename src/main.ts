import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { createModels } from "@earendil-works/pi-ai/models"
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";

const context = BACKGROUND_CONTEXT; // every call takes a context for cancellation
const models = createModels();
models.setProvider(openaiProvider());

const registry = createRegistry();
registry.install(CodingTools); // read, write, edit, bash

const env = ({ cwd }: { cwd?: string }) =>
  new NodeExecutionEnv({ cwd: cwd ?? process.cwd() });

const harness = await Harness.open(
  await openNodeSqliteStorage("./agent.sqlite"),
  { models, registry, env },
  context,
);

// The root conversation: created on first use, and the same one after every
// restart.
const root = await harness.root(context, {
  agent: {
    model: { provider: "openai", modelId: "gpt-6.1-sol" },
    cwd: import.meta.dirname,
  }
})

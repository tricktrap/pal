import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { type Context } from "@earendil-works/chord"
import { CodingTools } from "@earendil-works/pi-durable/tools";

import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { getLMStudioModels } from "./lmstudio.js";

export async function initializeHarness(context: Context): Promise<Harness> {
  const models = await getLMStudioModels();
  const env = ({ cwd }: { cwd?: string }) =>
    new NodeExecutionEnv({ cwd: cwd ?? process.cwd() });

  const registry = createRegistry();
  registry.install(CodingTools); // read, write, edit, bash

  return Harness.open(
    await openNodeSqliteStorage("./agent.sqlite"),
    { models, registry, env },
    context,
  );
}

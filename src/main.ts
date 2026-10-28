import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { AssistantEntry } from "@earendil-works/pi-durable";

import { initializeHarness } from "./runtime.js";

import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  options: {
    prompt: { type: 'string', short: 'p', default: 'Determine the language this project is written in' },
    verbose: { type: 'boolean', short: 'v', default: false }
  }, allowPositionals: true
});

const promptContent = values['prompt'];

const context = BACKGROUND_CONTEXT;
const harness = await initializeHarness(context);

// The root conversation: created on first use, and the same one after every
// restart.
const root = await harness.root(context, {
  agent: {
    model: { provider: "lmstudio", modelId: "qwen/qwen3.8-27b" },
    cwd: import.meta.dirname,
  }
});

const submission = await root.submit({ type: "input", content: promptContent }, context);
const settled = await submission.wait(context);

if (settled.status === "done" && settled.type === "input") {
  const answer = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
  console.log(answer?.model?.[0]);
}

await harness.close(context);

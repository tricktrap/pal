import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { AssistantEntry } from "@earendil-works/pi-durable";

import { initializeHarness } from "./runtime.js";

const DEFAULT_PROMPT = "Determine the language this project is written in";
function getPromptFromArgs(): string {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--prompt' || argv[i] === '-p') {
      return argv[i + 1] ?? DEFAULT_PROMPT;
    }
    if (argv[i].startsWith('--prompt=')) {
      return argv[i].slice('--prompt='.length);
    }
  }
  return DEFAULT_PROMPT;
}

const promptContent = getPromptFromArgs();

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

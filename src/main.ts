import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { AssistantEntry } from "@earendil-works/pi-durable";

import { initializeHarness } from "./runtime.js";

import { parseArgs } from 'node:util';
import { attachAcpAgent } from "./acp.js";
import { exit } from "node:process";
import { describeError, log } from "./log.js";

const { values } = parseArgs({
  options: {
    prompt: { type: 'string', short: 'p', default: 'Determine the language this project is written in' },
    verbose: { type: 'boolean', short: 'v', default: false },
    acp: { type: 'boolean', short: 'a', default: false }
  }, allowPositionals: true
});

// --verbose drives the logger's debug level (LOG_LEVEL env var also works).
if (values.verbose) {
  log.setLevel("debug");
}

const context = BACKGROUND_CONTEXT;

const harness = await (async () => {
  try {
    return await initializeHarness(context);
  } catch (err) {
    log.error("harness initialization failed", { err: describeError(err) });
    exit(1);
  }
})();

if (values['acp']) {
  log.info("initializing in ACP mode");
  attachAcpAgent(harness, context);
} else if (values['prompt']) {
  log.info("running prompt", { chars: String(values['prompt']).length });
  try {
    const root = await harness.root(context, {
      agent: {
        model: { provider: "lmstudio", modelId: "qwen/qwen3.8-27b" },
        cwd: import.meta.dirname,
      }
    });
    const promptContent = values['prompt'];
    const submission = await root.submit({ type: "input", content: promptContent }, context);
    const settled = await submission.wait(context);
    log.info("submission settled", {
      type: settled.type,
      status: settled.status,
      ...(settled.status === "unanswered" ? { reason: settled.reason } : {})
    });

    if (settled.status === "done" && settled.type === "input") {
      const answer = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
      console.log(answer?.model?.[0]);
    }

    await harness.close(context);
  } catch (err) {
    log.error("prompt run failed", { err: describeError(err) });
    exit(1);
  }
}

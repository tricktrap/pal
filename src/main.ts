import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { AssistantEntry } from "@earendil-works/pi-durable";

import { initializeHarness } from "./runtime.js";

import { parseArgs } from 'node:util';
import { attachAcpAgent } from "./acp.js";
import { exit } from "node:process";
import { describeError, log } from "./log.js";
import { WaitTimeoutError, withTimeout } from "./wait.js";

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

if (values['acp']) {
  for (const m of ["log", "info", "debug"] as const) {
    console[m] = (...args: unknown[]) =>
      process.stderr.write(`[log] ${args.map(String).join(" ")}\n`);
  }
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
  // Deadline for the whole prompt. The root conversation is shared, so a
  // prompt can queue behind another live session, or the model can stall;
  // without a deadline `submission.wait()` hangs forever. Raise for long
  // prompts, lower for fail-fast.
  const timeoutMs = Number(process.env.PROMPT_TIMEOUT_MS ?? 120_000);
  try {
    const root = await harness.root(context, {
      agent: {
        model: { provider: "lmstudio", modelId: "qwen/qwen3.8-27b" },
        cwd: import.meta.dirname,
      }
    });
    const promptContent = values['prompt'];
    const submission = await root.submit({ type: "input", content: promptContent }, context);
    log.debug("submission admitted", { id: submission.id });

    // Track progress (later: use watchEvents or something)
    // const view = await root.viewState(context);
    // render(view.value);
    // view.subscribe((value) => render(value));


    // Bound the wait. On the deadline we report a clean, distinguishable
    // timeout (and the submission's status, to tell "queued" from "stalled")
    // instead of hanging. We deliberately do NOT abort the shared
    // conversation here: doing so from a one-shot CLI could tear down another
    // live session that is legitimately holding the conversation.
    let settled;
    try {
      settled = await withTimeout(
        submission.wait(context),
        timeoutMs,
        () => submission.status(context),
      );
    } catch (err) {
      if (err instanceof WaitTimeoutError) {
        log.error("prompt timed out — no response within the deadline", { err: describeError(err), timeoutMs });
        log.error("hint", {
          hint: "the shared root conversation may be busy with another live session, or the model provider is unresponsive; raise PROMPT_TIMEOUT_MS for long prompts",
        });
        exit(124); // GNU `timeout` convention
      }
      throw err;
    }
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

# ACP Client Reliability Plan

**Goal:** Make the ACP client's experience reliable while waiting for a response from the agent — every request succeeds or fails within a bounded time, cancellations actually take effect, and no turn is silently empty.

**Context:** PAL is an ACP agent (`src/acp.ts`) built on the `@earendil-works/pi-durable` harness, using LM Studio as the model provider, speaking **ACP v1 stable** (the `@agentclientprotocol/sdk` root entry). Items are ordered by client-visible impact.

---

## 1. Make cancel actually cancel (highest priority)

**Problem.** `cancelSession` currently aborts an `AbortController` that **nothing is wired to**. The harness keeps generating. When the client sends the next prompt, the harness `submit()` queues it behind the still-running conversation (per its docs: "a busy conversation, or one with queued items, queues it in `pi.inbox`") — so prompt #2 silently waits the full duration of prompt #1, which the client already cancelled. This is the single most likely cause of "client waits a very long time for a response."

**Fix.** Route all cancellation through one helper that aborts the trigger *and* tears down the harness work:

```ts
private async cancelPrompt(session: AgentSession): Promise<void> {
  session.pendingPrompt?.abort();
  // Harness-native abort: withdraw queued inputs, signal live tasks,
  // resolve once the conversation is idle.
  await session.conversation.abort(this.context);
}
```

`Conversation.abort(context)` "withdraws queued inputs, marks every live non-background task, signals them, and resolves once the scope is idle." Both `cancelSession` and prompt supersession (a new prompt on the same session cancels the prior one) go through this helper.

## 2. Guarantee a response within bounded time (today there is none)

**Problem.** `submission.wait()` has no timeout — if LM Studio hangs or the harness stalls, `session/prompt` never completes and the client waits forever.

**Fix.** A wall-clock watchdog per prompt; on expiry, cancel and report a clean cancellation (ACP v1's `StopReason` includes `"cancelled"`):

```ts
const PROMPT_TIMEOUT_MS = 120_000; // tune to your model

const controller = new AbortController();
session.pendingPrompt = controller;
const watchdog = setTimeout(() => controller.abort(), PROMPT_TIMEOUT_MS);

try {
  // ... submit / wait / handle response ...
  return { stopReason: "end_turn" };
} catch (err) {
  if (controller.signal.aborted) {
    // Client cancel or wall-clock timeout: report a clean cancellation,
    // not a JSON-RPC error.
    return { stopReason: "cancelled" };
  }
  // Genuine failures stay errors: v1 has no "error" stop reason, and
  // "refusal" carries policy semantics.
  throw acp.RequestError.internalError(undefined, String(err));
} finally {
  clearTimeout(watchdog);
  // Only clear if we're still the pending prompt — a superseding prompt
  // may have installed its own controller by now.
  if (session.pendingPrompt === controller) {
    session.pendingPrompt = null;
  }
}
```

The same principle applies to `newSession`: `harness.root()` can block (e.g., a SQLite lock) — wrap it in a timeout that throws `RequestError.internalError` so the client gets an error at startup instead of hanging.

**The contract to give the client:** every request — prompt, new, close — either succeeds or fails within a bounded time. That's what "reliable waiting" actually means; the client's own timeout is only a backstop.

## 3. Handle `session/close` (currently unhandled)

v1 `AGENT_METHODS` includes `session_close: "session/close"`, but no handler is registered — a compliant client that closes a session gets `methodNotFound`, and the `sessions` map plus any in-flight work accumulate forever (long-lived clients like Zed: unbounded growth).

**Fix.** Register a handler that releases in-flight work and the in-memory entry (the conversation itself is durable in SQLite and survives by design):

```ts
.onRequest("session/close", async (ctx) => {
  const session = agent.sessions.get(ctx.params.sessionId);
  if (session) {
    agent.sessions.delete(ctx.params.sessionId);
    await agent.cancelPrompt(session); // release in-flight work
  }
  return {};
})
```

## 4. Never return a silently empty turn

- `handleImage` / `handleToolCall` are `// todo` no-ops — a response containing those blocks arrives as *nothing*. The v1 protocol has proper updates: `tool_call` / `tool_call_update` (both in the `SessionUpdate` union), and image blocks as `agent_message_chunk` content.
- `handleUndefined` is a no-op — at minimum log it; an empty `content` with `stopReason: "end_turn"` is indistinguishable from a protocol bug to the client.
- `settled.status === "unanswered"` currently falls through to a bare `end_turn` — surface it (log + consider an error response rather than a fake success).

## 5. Protect the stdio channel

Two verified facts make this a reliability item, not a style item: the client SDK **strict-parses** every `session/update` (`validate.zSessionNotification.parse(...)` — throws on violation), and any stray byte on stdout corrupts the ndjson framing of *every subsequent message* — after one bad line, the client appears "unreliable" for the rest of the session.

- Notification shapes are valid v1 (`ContentChunk` requires only `content`; `messageId` is optional) — keep them that way. If the SDK exposes the zod schema, consider `safeParse`-ing outgoing updates in dev to catch drift early.
- Kill `console.log` in ACP mode. Node's global `console` binds stdout at startup, so reassigning `process.stdout` doesn't help — patch the methods when attaching ACP mode:

```ts
for (const m of ["log", "info", "debug"] as const) {
  console[m] = (...args: unknown[]) =>
    process.stderr.write(`[log] ${args.map(String).join(" ")}\n`);
}
```

This also shields you from dependencies that log to stdout.

## 6. Process-level robustness

- **Unhandled rejections kill the agent mid-turn.** Node's default is to exit, which closes the pipe and kills the client's in-flight request with no JSON-RPC error. Add `process.on("unhandledRejection", (e) => log.error("unhandledRejection", { err: String(e) }))` (and consider a controlled shutdown so the client can detect it and reconnect).
- **Fail fast on model resolution.** The ACP path creates sessions with no model configured (commented out in `newSession`). If no default is set, the first prompt fails confusingly — resolve the model at `session/new` time and return a clean error there instead.

## 7. Observability (cross-cutting prerequisite)

Every failure mode above is currently *silent* — there's no log line anywhere in the ACP path. A small stderr logger (JSON lines; the existing unused `--verbose` flag can drive `debug` level) should land **first**: request received, cancel, settle status, response bytes, and every error. Otherwise you can't even tell which of these is biting you.

**Logger sketch** (~30 lines, zero dependencies):

```ts
type Level = "debug" | "info" | "warn" | "error";
const WEIGHT: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold = WEIGHT[(process.env.LOG_LEVEL as Level)] ?? WEIGHT.info;

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (WEIGHT[level] < threshold) return;
  process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }) + "\n");
}

export const log = {
  debug: (m: string, f?: object) => emit("debug", m, f),
  info:  (m: string, f?: object) => emit("info", m, f),
  warn:  (m: string, f?: object) => emit("warn", m, f),
  error: (m: string, f?: object) => emit("error", m, f),
  setLevel: (l: Level) => { threshold = WEIGHT[l]; },
};
```

> **Note:** in ACP mode logs must never go to stdout — stdout is the protocol channel.

---

## Verified non-problems

So these don't need chasing:

- Notification shapes are valid v1 (no missing required fields).
- Ordering is safe: all `cx.notify` calls are awaited before the final `PromptResponse`, and the single pipe preserves message order.
- `PromptResponse = { stopReason }` matches the v1 schema; `stopReason: "cancelled"` is a first-class v1 value.

## Recommended implementation sequence

1. **Logging (item 7)** — land first so everything else is diagnosable.
2. **Items 1 + 2** — one `cancelPrompt` helper + watchdog (~40 lines) — fixes the "client hangs" class entirely.
3. **Item 4** — implement the no-op handlers and surface `unanswered` — fixes the "empty response" class.
4. **Items 3, 5, 6** — `session/close`, the stdio guard, and process robustness — cheap insurance.

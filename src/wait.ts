/**
 * Bounded-wait helpers.
 *
 * The durable conversation is shared: a prompt can sit queued behind another
 * live session, or the model provider can stall. Any unbounded `wait` on such
 * work can hang forever. These helpers turn an unbounded wait into a bounded
 * one with a clear, distinguishable failure.
 */

/** Thrown when a bounded wait exceeds its deadline. */
export class WaitTimeoutError extends Error {
  constructor(message: string, readonly timeoutMs: number) {
    super(message);
    this.name = "WaitTimeoutError";
  }
}

/**
 * Await `promise`, rejecting with `WaitTimeoutError` after `timeoutMs` if it
 * does not settle.
 *
 * `diagnose` (optional) runs once the deadline fires — best-effort, with its
 * own short guard so it can never delay the timeout — and its result is
 * attached to the error message. It exists purely to make the failure
 * diagnosable (e.g. "was the submission still `queued` or already `placed`?").
 *
 * The deadline timer is cleared as soon as `promise` settles, so a fast
 * success never keeps the event loop alive until the deadline.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  diagnose?: () => unknown,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void (async () => {
        let detail = "";
        if (diagnose) {
          try {
            const value = await Promise.race([
              Promise.resolve(diagnose()),
              // Guard: the diagnostic must never outlive a short window.
              new Promise<undefined>((resolve) => setTimeout(resolve, 2_000)),
            ]);
            if (value !== undefined) detail = ` (status: ${JSON.stringify(value)})`;
          } catch {
            detail = "";
          }
        }
        reject(new WaitTimeoutError(`did not settle within ${timeoutMs}ms${detail}`, timeoutMs));
      })();
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, deadline]);
  } finally {
    // Clear the deadline once the race resolves so it cannot keep the process
    // alive after a fast success.
    if (timer !== undefined) clearTimeout(timer);
  }
}

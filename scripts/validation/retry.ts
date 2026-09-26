/**
 * Retry for the validation and import harnesses, which run long read and
 * write sequences against a remote database and a source-system connector.
 *
 * Only failures that leave nothing half-applied are retried: a dropped or
 * timed-out connection, and PostgreSQL deadlock (40P01) or serialization
 * (40001) aborts, which roll the transaction back. Any other error is thrown
 * on the first attempt, so a refusal from the code under the harness is never
 * re-run or masked.
 */
const TRANSIENT_CODES = ["40P01", "40001"];
const TRANSIENT_MESSAGE = /timeout|terminated|ECONN|ETIMEDOUT|EHOSTUNREACH|Connection/i;

export function isTransient(error: unknown): boolean {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  for (let current = error; current && !seen.has(current); ) {
    seen.add(current);
    messages.push(current instanceof Error ? current.message : String(current));
    const { code, cause } = typeof current === "object" ? (current as { code?: unknown; cause?: unknown }) : {};
    if (typeof code === "string" && TRANSIENT_CODES.includes(code)) return true;
    current = cause;
  }
  return TRANSIENT_MESSAGE.test(messages.join("\n"));
}

export async function retry<T>(fn: () => Promise<T>, attempts = 8, backoffMs = 1000): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!isTransient(error)) throw error;
      last = error;
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, backoffMs * (attempt + 1)));
    }
  }
  throw last;
}

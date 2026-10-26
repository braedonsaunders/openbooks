/**
 * A refusal from the multi-book services. `status` is the HTTP answer an
 * API boundary gives: 404 for a record that is missing or in another
 * organization (indistinguishable on purpose), 409 for a concurrent change,
 * 422 for every business refusal.
 */
export class MultiBookError extends Error {
  override readonly name = "MultiBookError";

  constructor(
    message: string,
    readonly status: 404 | 409 | 422 = 422,
  ) {
    super(message);
  }
}

export const MULTI_BOOK_DISABLED =
  "Multi-book accounting is turned off; turn it on in Company Settings → Features";

/**
 * Storage refusals carry the guard's own operator message (SQLSTATE 23514)
 * or an overlap (23P01); both become business refusals naming the remedy.
 */
export function multiBookStorageRefusal(error: unknown): MultiBookError | null {
  const chain: unknown[] = [];
  for (
    let cursor: unknown = error;
    cursor && chain.length < 5;
    cursor = (cursor as { cause?: unknown }).cause
  )
    chain.push(cursor);
  for (const item of chain) {
    const code = (item as { code?: string }).code;
    const message = (item as { message?: string }).message ?? "";
    if (code === "23P01") {
      return new MultiBookError(
        "another version already covers those dates; close its window first or start this one after it",
        409,
      );
    }
    if (code === "23514" && message) return new MultiBookError(message);
  }
  return null;
}

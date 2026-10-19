import { AsyncLocalStorage } from "node:async_hooks";

/**
 * A memo for one read-only render. While a page composes, the same read is
 * often asked for more than once (the same legal entity's records, the same
 * reader's authority, the same feature switch); inside a scope each such read
 * loads once and its answer is shared. Outside a scope every read loads
 * fresh, so commands, jobs and API calls are unaffected.
 *
 * A scope is opened only around a page loader, which issues reads and never
 * commands; memoized values are never mutated by their readers. A read that
 * fails is not remembered, so a retry within the scope loads again.
 */
const scope = new AsyncLocalStorage<Map<string, Promise<unknown>>>();

/** Run a read-only render with its own memo. */
export function withReadMemo<T>(work: () => Promise<T>): Promise<T> {
  return scope.run(new Map(), work);
}

/** The read's answer for `key`: loaded once per scope, or fresh outside one. */
export function memoizedRead<T>(key: string, load: () => Promise<T>): Promise<T> {
  const memo = scope.getStore();
  if (!memo) return load();
  const known = memo.get(key);
  if (known) return known as Promise<T>;
  const pending = load();
  memo.set(key, pending);
  pending.catch(() => {
    if (memo.get(key) === pending) memo.delete(key);
  });
  return pending;
}

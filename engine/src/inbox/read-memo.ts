/**
 * Per-read memo for the facts every inbox source re-derives about the same
 * actor: the org feature switches, the actor's person party, the actor's
 * pending gates. One registry read lists a dozen sources concurrently, and
 * without a shared memo each source resolves those facts again.
 *
 * Scope is exactly one registry read. `beginInboxRead` mints a fresh context
 * identity for that read and the memo lives in a WeakMap keyed by it, so it
 * cannot be forged by a caller, never outlives the read, and never crosses
 * requests. Contexts that did not come from `beginInboxRead` — the act path,
 * a direct adapter call — resolve every fact live, so a write and the
 * re-resolution before it never see a remembered authority.
 */
import type { InboxListContext } from "./types.ts";

const readMemos = new WeakMap<InboxListContext, Map<string, Promise<unknown>>>();

/** Open one registry read: a copy of the caller's context carrying a fresh memo. */
export function beginInboxRead(ctx: InboxListContext): InboxListContext {
  const readCtx = {
    ...ctx,
  };
  if (ctx.scope) {
    readCtx.scope = {
      ...ctx.scope,
      ...(ctx.scope.roles ? { roles: [...ctx.scope.roles] } : {}),
      ...(ctx.scope.allowedSubsidiaryIds ? { allowedSubsidiaryIds: [...ctx.scope.allowedSubsidiaryIds] } : {}),
    };
  }
  readMemos.set(readCtx, new Map());
  return readCtx;
}

/**
 * Resolve `key` once per read. Concurrent sources share the in-flight
 * promise, so a fact is read once even when every source asks at the same
 * time; a failed read fails every source that depends on it, exactly as if
 * each had read it itself. Outside a read the loader runs every time.
 */
export function memoizeForRead<T>(ctx: InboxListContext, key: string, load: () => Promise<T>): Promise<T> {
  const memo = readMemos.get(ctx);
  if (!memo) return load();
  const known = memo.get(key);
  if (known) return known as Promise<T>;
  const pending = load();
  memo.set(key, pending);
  return pending;
}

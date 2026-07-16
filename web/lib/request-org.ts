import "server-only";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external";
import { registerRequestOrgResolver } from "@openbooks/engine/src/db.ts";

/**
 * Request-scoped RLS org context for the Next.js server.
 *
 * AsyncLocalStorage.enterWith() inside an awaited helper does NOT propagate to
 * the caller's async context — when `await currentUser()` returns, the caller
 * resumes with no store and every query would fall back to bypass. So instead
 * of entering a context from the inside, the resolved org is parked here keyed
 * on Next's per-request WorkStore (the same AsyncLocalStorage that powers
 * cookies()/headers(), live in server components, route handlers and server
 * actions alike), and the engine's connection layer reads it back on every
 * query via the registered resolver.
 */

const requestOrg = new WeakMap<object, { orgId: string | null; bypass: boolean }>();

/** Scope every subsequent db query in this request to `orgId` (RLS enforced). */
export function setRequestOrg(orgId: string): void {
  const store = workAsyncStorage.getStore();
  if (store) requestOrg.set(store, { orgId, bypass: false });
}

registerRequestOrgResolver(() => {
  const store = workAsyncStorage.getStore();
  return store ? requestOrg.get(store) : undefined;
});

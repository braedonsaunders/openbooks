import "server-only";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external";
import { registerRequestOrgResolver } from "@openbooks/engine/src/db.ts";
import { requestOrgByWorkStore } from "./request-org-state";

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

/** Scope every subsequent db query in this request to `orgId` (RLS enforced). */
export function setRequestOrg(orgId: string): void {
  const store = workAsyncStorage.getStore();
  if (store) requestOrgByWorkStore.set(store, { orgId, bypass: false });
}

registerRequestOrgResolver(() => {
  const store = workAsyncStorage.getStore();
  // During Next app rendering there is always a request store, even before
  // `currentUser()` resolves and seeds `setRequestOrg`.
  // Returning a denied tenant scope for that empty window is safer than silently
  // falling back to trusted bypass.
  if (!store) return undefined;
  return requestOrgByWorkStore.get(store) ?? { orgId: "", bypass: false };
});

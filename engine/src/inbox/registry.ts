/**
 * HR-15 inbox adapter registry.
 *
 * Every adapter speaks the same interface — list() reads through the
 * source's own gate (the inbox never widens visibility) and act()
 * delegates to the EXISTING write service (never a second write path).
 * Dedupe contract: a flow gate whose subject is owned by a dedicated
 * adapter (leave, change request, timesheet week, expense report) is
 * listed by that adapter and EXCLUDED from flows_approval, so one piece
 * of work is exactly one inbox item.
 */

import type { InboxItem, InboxKind, InboxListContext } from "./types.ts";
import { compareInboxItems } from "./types.ts";

export interface InboxAdapter {
  readonly kind: InboxKind;
  /** Fail-closed reads: only rows the actor may already see. */
  list(ctx: InboxListContext): Promise<InboxItem[]>;
  /**
   * Complete the action through the source's native service. Throws the
   * service's own refusal (reason missing, stale item, invisible item)
   * with its message intact — never a silent no-op.
   */
  act(
    ctx: InboxListContext,
    sourceId: string,
    actionKey: string,
    reason?: string | null,
  ): Promise<void>;
}

export class InboxError extends Error {
  readonly name = "InboxError";
  constructor(
    readonly code: "NOT_FOUND" | "REFUSED" | "REASON_REQUIRED" | "UNKNOWN_ACTION",
    message: string,
  ) {
    super(message);
  }
}

const adapters = new Map<InboxKind, InboxAdapter>();

export function registerInboxAdapter(adapter: InboxAdapter): void {
  adapters.set(adapter.kind, adapter);
}

export function inboxAdapterKinds(): InboxKind[] {
  return [...adapters.keys()];
}

function adapterFor(kind: string): InboxAdapter | null {
  return (adapters.get(kind as InboxKind) ?? null) as InboxAdapter | null;
}

/**
 * Live read over every registered adapter. A small per-request cache
 * (Map passed by the caller, scoped to one request) avoids re-reading a
 * source the home page and the badge both ask for. Deterministic: the
 * merged list is sorted overdue → due soon → newest with a stable id
 * tiebreak.
 */
export async function listInbox(
  ctx: InboxListContext,
  opts?: { kinds?: InboxKind[]; cache?: Map<string, InboxItem[]> },
): Promise<InboxItem[]> {
  const kinds = opts?.kinds ?? inboxAdapterKinds();
  const out: InboxItem[] = [];
  for (const kind of kinds) {
    const adapter = adapterFor(kind);
    if (!adapter) continue;
    const cacheKey = `${ctx.orgId}:${ctx.actorId}:${kind}`;
    const cached = opts?.cache?.get(cacheKey);
    if (cached) {
      out.push(...cached);
      continue;
    }
    const items = await adapter.list(ctx);
    opts?.cache?.set(cacheKey, items);
    out.push(...items);
  }
  return out.sort(compareInboxItems);
}

export async function countInbox(
  ctx: InboxListContext,
  opts?: { kinds?: InboxKind[]; cache?: Map<string, InboxItem[]> },
): Promise<number> {
  return (await listInbox(ctx, opts)).length;
}

/**
 * Act on one item. Unknown items and items from sources the actor cannot
 * see resolve to NOT_FOUND (404, never 403 — existence must not leak
 * across the visibility boundary). Unknown actions and missing reasons
 * are named refusals.
 */
export async function actOnInboxItem(
  ctx: InboxListContext,
  itemId: string,
  actionKey: string,
  reason?: string | null,
): Promise<void> {
  const sep = itemId.indexOf(":");
  if (sep < 0) throw new InboxError("NOT_FOUND", "inbox item not found");
  const kind = itemId.slice(0, sep);
  const sourceId = itemId.slice(sep + 1);
  if (!kind || !sourceId) throw new InboxError("NOT_FOUND", "inbox item not found");
  const adapter = adapterFor(kind);
  if (!adapter) throw new InboxError("NOT_FOUND", "inbox item not found");
  // Re-resolve the item through the source's own gate: an item the actor
  // cannot see (or that already resolved) is NOT_FOUND, never a leak.
  // Matched on the stable item id (kind + source pointer).
  const visible = await adapter.list(ctx);
  const item = visible.find((candidate) => candidate.id === itemId);
  if (!item) throw new InboxError("NOT_FOUND", "inbox item not found — it may already be decided or outside your scope");
  if (!item.actions.some((action) => action.key === actionKey)) {
    throw new InboxError(
      "UNKNOWN_ACTION",
      `action ${JSON.stringify(actionKey)} is not available on this item — reload the inbox and use one of its listed actions`,
    );
  }
  const def = item.actions.find((action) => action.key === actionKey)!;
  if (def.needsReason && !reason?.trim()) {
    throw new InboxError(
      "REASON_REQUIRED",
      `a reason is required to ${def.label.toLowerCase()} — add the reason so the audit keeps who decided what and why`,
    );
  }
  await adapter.act(ctx, sourceId, actionKey, reason?.trim() || null);
}

/** Test seam: swap the registry contents for fake-source unit tests. */
export function __testResetInboxAdapters(next: InboxAdapter[] = []): void {
  adapters.clear();
  for (const adapter of next) adapters.set(adapter.kind, adapter);
}

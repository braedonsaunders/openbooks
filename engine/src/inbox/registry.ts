/**
 * HR-15 inbox adapter registry.
 *
 * Every adapter speaks the same interface — list() reads through the
 * source's own gate (the inbox never widens visibility) and act()
 * delegates to the EXISTING write service (never a second write path).
 * Dedupe contract: a flow gate whose subject is owned by a dedicated
 * adapter (leave, change request, timesheet week, expense report,
 * crew batch) is listed by that adapter and EXCLUDED from flows_approval,
 * so one piece of work is exactly one inbox item.
 */

import type { InboxItem, InboxKind, InboxListContext } from "./types.ts";
import { compareInboxItems } from "./types.ts";
import { HrmAuthorizationError } from "../hrm/authorization.ts";
import { beginInboxRead } from "./read-memo.ts";

/**
 * A read window for one source. Applies per source (not to the merged
 * list): single-kind reads page exactly; multi-kind reads bound each leg.
 * Absent means the source's bounded default window — never the whole table.
 */
export interface InboxPage {
  readonly limit?: number;
  readonly offset?: number;
}

export interface InboxAdapter {
  readonly kind: InboxKind;
  /** Fail-closed reads: only rows the actor may already see. */
  list(ctx: InboxListContext, page?: InboxPage): Promise<InboxItem[]>;
  /**
   * Resolve ONE item by its source id through the source's own gate —
   * the same visibility predicate the list applies, never a wider read.
   * Absent means the registry re-resolves through the list window, so an
   * item outside a windowed source's first page is unactionable until the
   * source implements this. Sources with a bounded default window must
   * implement it, or counted items stay visible nowhere and unactionable.
   */
  lookup?(ctx: InboxListContext, sourceId: string): Promise<InboxItem | null>;
  /**
   * The badge count without materializing rows. Absent means the list
   * length — sources whose list is windowed must implement this, or the
   * badge undercounts past the window.
   */
  count?(ctx: InboxListContext): Promise<number>;
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
 * One source that could not be read. The kind names the area so the surface
 * can say WHICH work is missing. `refused` carries a designed adapter
 * refusal intact (its remedy is the message); `failed` is an unexpected
 * source failure with a generic reason the surface replaces with plain,
 * localized copy — driver text never reaches the rendered notice.
 */
export interface InboxSourceNotice {
  readonly kind: InboxKind;
  readonly code: "refused" | "failed";
  readonly message: string;
}

/**
 * One source's refusal or failure must not blank the whole inbox (OM-10).
 * The failure is named into the caller's notices collector (when supplied)
 * so the surface renders it beside the surviving sources; a failed leg is
 * never cached, so a retry re-reads rather than serving an empty list as
 * "no work".
 *
 * A source the actor holds no grant for, or whose module is switched off,
 * is not a failure: the actor simply has no work there, so the refusal
 * contributes nothing and names nothing — a personal inbox never lists
 * permission keys or setup routes at the person it refused. Anything
 * unexpected logs the way the house does.
 */
function recordSourceFailure(kind: InboxKind, error: unknown, notices?: InboxSourceNotice[]): void {
  if (error instanceof HrmAuthorizationError) return;
  // A source whose module is switched off has no work to show either.
  if ((error as { code?: unknown } | null)?.code === "FEATURE_OFF") return;
  if (error instanceof InboxError) {
    notices?.push({ kind, code: "refused", message: error.message });
    return;
  }
  console.error(`[inbox] ${kind} list failed:`, error);
  notices?.push({ kind, code: "failed", message: "the inbox source could not be read" });
}

/**
 * Live read over every registered adapter. Each source is isolated: one
 * source's refusal or failure names itself in `opts.notices` while the
 * other sources still list. A small per-request cache (Map passed by the
 * caller, scoped to one request) avoids re-reading a source the home page
 * and the badge both ask for. Deterministic: the merged list is sorted
 * overdue → due soon → newest with a stable id tiebreak.
 */
export async function listInbox(
  ctx: InboxListContext,
  opts?: { kinds?: InboxKind[]; cache?: Map<string, InboxItem[]>; page?: InboxPage; notices?: InboxSourceNotice[] },
): Promise<InboxItem[]> {
  const read = beginInboxRead(ctx);
  const legs = await readSources(read, opts?.kinds, opts?.page ? undefined : opts?.cache, async (adapter, cacheKey) => {
    if (opts?.page) return adapter.list(read, opts.page);
    const items = await adapter.list(read);
    opts?.cache?.set(cacheKey, items);
    return items;
  }, opts?.notices);
  return legs.flat().sort(compareInboxItems);
}

export async function countInbox(
  ctx: InboxListContext,
  opts?: { kinds?: InboxKind[]; cache?: Map<string, InboxItem[]>; notices?: InboxSourceNotice[] },
): Promise<number> {
  const read = beginInboxRead(ctx);
  const legs = await readSources(read, opts?.kinds, opts?.cache, async (adapter, cacheKey) => {
    if (adapter.count) return adapter.count(read);
    const items = await adapter.list(read);
    opts?.cache?.set(cacheKey, items);
    return items.length;
  }, opts?.notices);
  return legs.reduce<number>((total, leg) => total + (typeof leg === "number" ? leg : leg.length), 0);
}

/**
 * Read every requested source concurrently. Sources are independent and each
 * runs through its own gate, so the slowest source bounds the read instead of
 * the sum of all of them. The actor facts the sources share resolve once per
 * read through the read memo. A cached leg is served from the request cache; a
 * failed leg contributes nothing and names itself in `notices`, recorded in
 * source order so the surface renders them deterministically.
 */
async function readSources<T>(
  ctx: InboxListContext,
  requested: InboxKind[] | undefined,
  cache: Map<string, InboxItem[]> | undefined,
  read: (adapter: InboxAdapter, cacheKey: string) => Promise<T>,
  notices: InboxSourceNotice[] | undefined,
): Promise<(T | InboxItem[])[]> {
  const kinds = requested ?? inboxAdapterKinds();
  const settled = await Promise.all(kinds.map(async (kind) => {
    const adapter = adapterFor(kind);
    if (!adapter) return null;
    const cacheKey = JSON.stringify({
      orgId: ctx.orgId, actorId: ctx.actorId, asOf: ctx.asOf, kind,
      // Missing scope asks the native reader to resolve authority; explicit
      // null means unrestricted. Object fields preserve that distinction.
      scope: {
        roles: ctx.scope?.roles,
        allowedSubsidiaryIds: ctx.scope?.allowedSubsidiaryIds,
        includeBudgets: ctx.scope?.includeBudgets,
      },
    });
    const cached = cache?.get(cacheKey);
    if (cached) return { value: cached as T | InboxItem[] };
    try {
      return { value: await read(adapter, cacheKey) as T | InboxItem[] };
    } catch (error) {
      return { kind, error };
    }
  }));
  const values: (T | InboxItem[])[] = [];
  for (const leg of settled) {
    if (!leg) continue;
    if ("error" in leg) recordSourceFailure(leg.kind, leg.error, notices);
    else values.push(leg.value);
  }
  return values;
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
  // Discard any registry-read memo before re-resolving write authority.
  ctx = { ...ctx };
  const sep = itemId.indexOf(":");
  if (sep < 0) throw new InboxError("NOT_FOUND", "inbox item not found");
  const kind = itemId.slice(0, sep);
  const sourceId = itemId.slice(sep + 1);
  if (!kind || !sourceId) throw new InboxError("NOT_FOUND", "inbox item not found");
  const adapter = adapterFor(kind);
  if (!adapter) throw new InboxError("NOT_FOUND", "inbox item not found");
  // Re-resolve the item through the source's own gate: an item the actor
  // cannot see (or that already resolved) is NOT_FOUND, never a leak.
  // Matched on the stable item id (kind + source pointer). A source with
  // a direct lookup resolves BY ID, so an item outside the list's bounded
  // window stays actionable; without one the first window arbitrates.
  const item = adapter.lookup
    ? await adapter.lookup(ctx, sourceId)
    : (await adapter.list(ctx)).find((candidate) => candidate.id === itemId) ?? null;
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

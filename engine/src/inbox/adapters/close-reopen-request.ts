/**
 * close_reopen_request adapter — period reopen requests waiting on an
 * independent approver.
 *
 * A reopen request is decided by someone other than the requester who holds
 * close.reopen. Reopening invalidates the organization-wide close review, so
 * the decision needs an unrestricted subsidiary scope (the same rule as the
 * close setup route). Every pending request someone else filed lists here
 * for each such holder, and approve/reject run through decidePeriodReopen —
 * the native service that refuses self-approval and records the decider.
 */

import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import { actorPermissionOn } from "../guard.ts";
import { InboxError, type InboxAdapter } from "../registry.ts";
import type { InboxItem, InboxListContext } from "../types.ts";
import { inboxItemId } from "../types.ts";

type ReopenRow = {
  id: string;
  period_name: string;
  book_name: string;
  subsidiary_name: string | null;
  modules: string[];
  reason: string;
  requester_name: string | null;
  created_at: string;
};

export const REOPEN_REQUESTS_HREF = "/accounting/reopen-requests";

async function mayDecide(ctx: InboxListContext): Promise<boolean> {
  if (!(await actorPermissionOn(ctx, "close.reopen"))) return false;
  const { actorAllowedSubsidiaryIds } = await import("../../organization/actor-subsidiaries.ts");
  return (await actorAllowedSubsidiaryIds(ctx.exec ?? db, ctx.orgId, ctx.actorId)) === null;
}

async function pendingRequests(ctx: InboxListContext, requestId?: string): Promise<ReopenRow[]> {
  return (await (ctx.exec ?? db).execute<ReopenRow>(sql`
    select r.id::text as id, p.name as period_name, b.name as book_name, s.name as subsidiary_name,
           r.modules, r.reason, req.name as requester_name, r.created_at::text as created_at
      from close_reopen_requests r
      join accounting_periods p on p.id = r.period_id and p.org_id = r.org_id
      join accounting_books b on b.id = r.book_id and b.org_id = r.org_id
      left join subsidiaries s on s.id = r.subsidiary_id and s.org_id = r.org_id
      left join users req on req.id = r.requested_by
     where r.org_id = ${ctx.orgId} and r.status = 'requested' and r.requested_by <> ${ctx.actorId}
       ${requestId ? sql`and r.id = ${requestId}` : sql``}
     order by r.created_at
     limit 50
  `)).rows;
}

function toItem(row: ReopenRow): InboxItem {
  const scope = [row.book_name, row.subsidiary_name].filter(Boolean).join(" · ");
  return {
    id: inboxItemId("close_reopen_request", row.id),
    kind: "close_reopen_request",
    title: `Period reopen requested: ${row.period_name}`,
    subtitle: `${scope} — ${row.modules.join(", ")} — ${row.reason}${row.requester_name ? ` (requested by ${row.requester_name})` : ""}`,
    dueAt: null,
    createdAt: new Date(row.created_at).toISOString(),
    priority: "due_soon",
    subjectHref: `${REOPEN_REQUESTS_HREF}?request=${row.id}`,
    actions: [
      { key: "approve", label: "Approve", style: "primary", needsReason: false },
      { key: "reject", label: "Reject", style: "danger", needsReason: false },
    ],
    source: { kind: "close_reopen_request", id: row.id },
  };
}

export const closeReopenRequestAdapter: InboxAdapter = {
  kind: "close_reopen_request",
  async list(ctx) {
    if (!(await mayDecide(ctx))) return [];
    return (await pendingRequests(ctx)).map(toItem);
  },
  async lookup(ctx, sourceId) {
    if (!(await mayDecide(ctx))) return null;
    if (!/^[0-9a-f-]{36}$/i.test(sourceId)) return null;
    const row = (await pendingRequests(ctx, sourceId))[0];
    return row ? toItem(row) : null;
  },
  async act(ctx, sourceId, actionKey) {
    if (actionKey !== "approve" && actionKey !== "reject") {
      throw new InboxError("UNKNOWN_ACTION", `action ${JSON.stringify(actionKey)} is not available on a reopen request`);
    }
    const { decidePeriodReopen } = await import("../../close/reopening.ts");
    await decidePeriodReopen({ orgId: ctx.orgId, requestId: sourceId, actorId: ctx.actorId, approve: actionKey === "approve" });
  },
};

import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { can, getAuthz } from "../../../../../lib/authz";
import { isUuid } from "../../../../../lib/list-params";
import { canReadContinuousCloseAgent, loadWorkItemAccess } from "../../../../../lib/continuous-close";

const ACTION_STATUS = {
  review: "in_review",
  resolve: "resolved",
  dismiss: "dismissed",
  reopen: "open",
} as const;

const ALLOWED_ACTIONS = {
  open: ["review", "resolve", "dismiss"],
  in_review: ["resolve", "dismiss", "reopen"],
  resolved: ["reopen"],
  dismissed: ["reopen"],
} as const;

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(authz, "assistant.write")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const access = await loadWorkItemAccess(authz.user.orgId, id);
  if (!access) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!canReadContinuousCloseAgent(authz, access.agentKey)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const action = typeof body.action === "string" ? body.action : "";
  if (!(action in ACTION_STATUS)) return NextResponse.json({ error: "invalid_action" }, { status: 422 });
  if (!(ALLOWED_ACTIONS[access.status] as readonly string[]).includes(action)) {
    return NextResponse.json({ error: "invalid_transition" }, { status: 409 });
  }
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
  if (action === "dismiss" && !reason) {
    return NextResponse.json({ error: "reason_required" }, { status: 422 });
  }
  const status = ACTION_STATUS[action as keyof typeof ACTION_STATUS];
  const updated = await db.transaction(async (tx) => {
    const changed = (await tx.execute<{ id: string }>(sql`
      update ai_work_items set
        status = ${status},
        resolved_at = case when ${status} = 'resolved' then now() else null end,
        resolved_by = case when ${status} = 'resolved' then ${authz.user.id}::uuid else null end,
        dismissed_at = case when ${status} = 'dismissed' then now() else null end,
        dismissed_by = case when ${status} = 'dismissed' then ${authz.user.id}::uuid else null end,
        dismissal_reason = case when ${status} = 'dismissed' then ${reason} else null end,
        updated_at = now(), updated_by = ${authz.user.id}
       where id = ${id} and org_id = ${authz.user.orgId} and status = ${access.status}
       returning id
    `));
    if (changed.rows.length === 0) return false;
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${authz.user.orgId}, 'ai_work_items', ${id}, 'update',
              ${JSON.stringify({ action, status, reason: reason || null })}::jsonb, ${authz.user.id})
    `);
    return true;
  });
  if (!updated) return NextResponse.json({ error: "conflict" }, { status: 409 });
  return NextResponse.json({ ok: true, status });
}

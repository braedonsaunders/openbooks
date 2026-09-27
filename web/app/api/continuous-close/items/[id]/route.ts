import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { isUuid } from "../../../../../lib/list-params";
import { can, guardRootSubsidiaryScope, subsidiaryScopeAllows } from "../../../../../lib/authz";
import {
  canReadContinuousCloseAgent,
  loadWorkItemAccess,
  readableContinuousCloseAgents,
  withLockedWorkItemAccess,
} from "../../../../../lib/continuous-close";
import { loadWorkItemDetail } from "../../../../../lib/agents/work-item";
import { findingProposalCommand } from "../../../../../lib/agents/proposals";
import {
  addWorkItemNote,
  listWorkItemNotes,
  loadWorkItemAssignment,
  setWorkItemAssignment,
} from "../../../../../lib/agents/assignments";
import { notFound } from "@/lib/api/responses";


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

const itemParams = z.object({ id: z.string() });
const itemActionBody = z.discriminatedUnion("action", [
  z.object({ action: z.enum(["review", "resolve", "dismiss", "reopen"]), reason: z.string().optional() }),
  z.object({ action: z.literal("assign"), assigneeUserId: z.string().nullable().optional(), assigneeRole: z.string().nullable().optional(), dueAt: z.string().nullable().optional() }),
  z.object({ action: z.literal("note"), body: z.string() }),
]);

export const GET = defineRoute({
  permission: "assistant.use",
  feature: "continuousClose",
  params: itemParams,
  handler: async ({ authz, params: { id } }) => {
  if (!isUuid(id)) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const item = await loadWorkItemDetail(
    authz.user.orgId,
    authz.user.id,
    id,
    readableContinuousCloseAgents(authz),
    authz.allowedSubsidiaryIds,
  );
  if (!item) return notFound("record");
  const canWrite = can(authz, "assistant.write");
  const [assignment, notes] = await Promise.all([
    loadWorkItemAssignment(authz, id),
    listWorkItemNotes(authz, id),
  ]);
  return NextResponse.json({
    ok: true,
    item,
    canWrite,
    proposal: canWrite ? findingProposalCommand(authz, item.summary) : null,
    assignment,
    notes,
  });
  },
});

export const PATCH = defineRoute({
  permission: "assistant.write",
  feature: "continuousClose",
  params: itemParams,
  body: itemActionBody,
  handler: async ({ authz, params: { id }, body }) => {
  if (!isUuid(id)) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const access = await loadWorkItemAccess(authz.user.orgId, id);
  if (!access) return notFound("record");
  if (!canReadContinuousCloseAgent(authz, access.agentKey)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  // Lifecycle and assignment writes move another entity's finding when the
  // subject is out of scope: restricted callers share the uniform not-found.
  if (!subsidiaryScopeAllows(authz.allowedSubsidiaryIds, access.subjectSubsidiaryId)) {
    return notFound("record");
  }
  const action = body.action;
  if (action === "assign" || action === "note") {
    if (action === "assign") {
      const scopeDenied = await guardRootSubsidiaryScope(authz);
      if (scopeDenied) return scopeDenied;
    }
    const result =
      action === "assign"
        ? await setWorkItemAssignment(authz, id, {
            assigneeUserId: "assigneeUserId" in body ? (body.assigneeUserId as string | null) : undefined,
            assigneeRole: "assigneeRole" in body ? (body.assigneeRole as string | null) : undefined,
            dueAt: "dueAt" in body ? (body.dueAt as string | null) : undefined,
          })
        : await addWorkItemNote(authz, id, body.body);
    if (!result.ok) {
      const status =
        result.error === "not_found" ? 404 : result.error === "forbidden" ? 403 : 422;
      return NextResponse.json({ error: result.error }, { status });
    }
    if (action === "note" && "id" in result) return NextResponse.json({ ok: true, id: result.id });
    return NextResponse.json({ ok: true });
  }
  if (!(action in ACTION_STATUS)) return NextResponse.json({ error: "invalid_action" }, { status: 422 });
  if (!(ALLOWED_ACTIONS[access.status] as readonly string[]).includes(action)) {
    return NextResponse.json({ error: "invalid_transition" }, { status: 409 });
  }
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
  if (action === "dismiss" && !reason) {
    return NextResponse.json({ error: "reason_required" }, { status: 422 });
  }
  const status = ACTION_STATUS[action as keyof typeof ACTION_STATUS];
  // Re-resolve agent, scope, and lifecycle inside the same
  // row-locked transaction as the write — the pre-check above still guards
  // the assign/note path, but a rehome between a pre-check and this write
  // would move another entity's finding under it.
  const result = await withLockedWorkItemAccess(authz.user.orgId, id, async (tx, locked) => {
    if (!canReadContinuousCloseAgent(authz, locked.agentKey)) return { error: "forbidden" as const };
    if (!subsidiaryScopeAllows(authz.allowedSubsidiaryIds, locked.subjectSubsidiaryId)) {
      return { error: "not_found" as const };
    }
    if (!(ALLOWED_ACTIONS[locked.status] as readonly string[]).includes(action)) {
      return { error: "invalid_transition" as const };
    }
    const changed = (await tx.execute<{ id: string }>(sql`
      update ai_work_items set
        status = ${status},
        resolved_at = case when ${status} = 'resolved' then now() else null end,
        resolved_by = case when ${status} = 'resolved' then ${authz.user.id}::uuid else null end,
        dismissed_at = case when ${status} = 'dismissed' then now() else null end,
        dismissed_by = case when ${status} = 'dismissed' then ${authz.user.id}::uuid else null end,
        dismissal_reason = case when ${status} = 'dismissed' then ${reason} else null end,
        updated_at = now(), updated_by = ${authz.user.id}
       where id = ${id} and org_id = ${authz.user.orgId} and status = ${locked.status}
       returning id
    `));
    if (changed.rows.length === 0) return { error: "conflict" as const };
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${authz.user.orgId}, 'ai_work_items', ${id}, 'update',
              ${JSON.stringify({ action, status, reason: reason || null })}::jsonb, ${authz.user.id})
    `);
    return { status };
  });
  if (!result) return notFound("record");
  if ("error" in result) {
    const statusCode = result.error === "not_found" ? 404 : result.error === "forbidden" ? 403 : 409;
    return NextResponse.json({ error: result.error }, { status: statusCode });
  }
  return NextResponse.json({ ok: true, status: result.status });
  },
});

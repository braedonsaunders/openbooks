import "server-only";
import { sql } from "drizzle-orm";
import { can, type Authz } from "../authz";
import {
  canReadContinuousCloseAgent,
  loadWorkItemAccess,
  readableContinuousCloseAgents,
  withLockedWorkItemAccess,
} from "../continuous-close";
import { addWorkItemNote, setWorkItemAssignment } from "../agents/assignments";
import { workItemSubjectInScope } from "../agents/work-item-subsidiary-scope";

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

export type ContinuousCloseItemAction =
  | { action: "review" | "resolve" | "dismiss" | "reopen"; reason?: string }
  | {
      action: "assign";
      assigneeUserId?: string | null;
      assigneeRole?: string | null;
      dueAt?: string | null;
    }
  | { action: "note"; body: string };

export type ContinuousCloseItemActionResult =
  { ok: true; status?: string; id?: string } | { ok: false; error: string; status: number };

export function canManageAnyContinuousCloseItem(authz: Authz): boolean {
  return can(authz, "assistant.write") && readableContinuousCloseAgents(authz).length > 0;
}

/** Shared route and command path for continuous-close finding actions. */
export async function updateContinuousCloseItem(
  authz: Authz,
  itemId: string,
  input: ContinuousCloseItemAction,
): Promise<ContinuousCloseItemActionResult> {
  const access = await loadWorkItemAccess(authz.user.orgId, itemId, authz.allowedSubsidiaryIds);
  if (!access) return { ok: false, error: "not_found", status: 404 };
  if (!canReadContinuousCloseAgent(authz, access.agentKey))
    return { ok: false, error: "forbidden", status: 403 };
  if (
    !workItemSubjectInScope(
      authz.allowedSubsidiaryIds,
      access.subjectType ?? "",
      access.subjectSubsidiaryId,
    )
  ) {
    return { ok: false, error: "not_found", status: 404 };
  }

  if (input.action === "assign" || input.action === "note") {
    const result =
      input.action === "assign"
        ? await setWorkItemAssignment(authz, itemId, {
            assigneeUserId: input.assigneeUserId,
            assigneeRole: input.assigneeRole,
            dueAt: input.dueAt,
          })
        : await addWorkItemNote(authz, itemId, input.body);
    if (!result.ok) {
      const status = result.error === "not_found" ? 404 : result.error === "forbidden" ? 403 : 422;
      return { ok: false, error: result.error, status };
    }
    return { ok: true, ...(input.action === "note" && "id" in result ? { id: result.id } : {}) };
  }

  if (!(ALLOWED_ACTIONS[access.status] as readonly string[]).includes(input.action))
    return { ok: false, error: "invalid_transition", status: 409 };
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 500) : "";
  if (input.action === "dismiss" && !reason)
    return { ok: false, error: "reason_required", status: 422 };
  const status = ACTION_STATUS[input.action];
  const result = await withLockedWorkItemAccess(
    authz.user.orgId,
    itemId,
    authz.allowedSubsidiaryIds,
    async (tx, locked) => {
      if (!canReadContinuousCloseAgent(authz, locked.agentKey))
        return { error: "forbidden" as const };
      if (
        !workItemSubjectInScope(
          authz.allowedSubsidiaryIds,
          locked.subjectType ?? "",
          locked.subjectSubsidiaryId,
        )
      ) {
        return { error: "not_found" as const };
      }
      if (!(ALLOWED_ACTIONS[locked.status] as readonly string[]).includes(input.action))
        return { error: "invalid_transition" as const };
      const changed = await tx.execute<{ id: string }>(
        sql`
        update ai_work_items set
          status = ${status},
          resolved_at = case when ${status} = 'resolved' then now() else null end,
          resolved_by = case when ${status} = 'resolved' then ${authz.user.id}::uuid else null end,
          dismissed_at = case when ${status} = 'dismissed' then now() else null end,
          dismissed_by = case when ${status} = 'dismissed' then ${authz.user.id}::uuid else null end,
          dismissal_reason = case when ${status} = 'dismissed' then ${reason} else null end,
          updated_at = now(), updated_by = ${authz.user.id}
         where id = ${itemId} and org_id = ${authz.user.orgId} and status = ${locked.status}
         returning id
      `,
        "objects",
      );
      if (changed.length !== 1) return { error: "conflict" as const };
      const audited = await tx.execute<{ id: string }>(
        sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${authz.user.orgId}, 'ai_work_items', ${itemId}, 'update',
                ${JSON.stringify({ action: input.action, status, reason: reason || null })}::jsonb,
                ${authz.user.id})
        returning row_id as id
      `,
        "objects",
      );
      if (audited.length !== 1)
        throw new Error("Continuous-close item audit record was not saved.");
      return { status };
    },
  );
  if (!result) return { ok: false, error: "not_found", status: 404 };
  if ("error" in result) {
    return {
      ok: false,
      error: result.error,
      status: result.error === "not_found" ? 404 : result.error === "forbidden" ? 403 : 409,
    };
  }
  return { ok: true, status: result.status };
}

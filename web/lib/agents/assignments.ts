import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { can, subsidiaryScopeAllows, type Authz } from "../authz";
import { canReadContinuousCloseAgent, loadWorkItemAccess } from "../continuous-close";

/**
 * Assignment & SLA for workbench findings (migration 0153): assign a finding
 * to an org user or an org role with a due date, and keep a comment thread.
 *
 * Reads stay on the shared loaders (pack visibility matches the workbench);
 * writes require assistant.write like the status transitions. Assignees must
 * exist in the org (user id or app_roles id) — free text would silently
 * route findings at nobody.
 */

export const MAX_NOTE_CHARS = 4000;
export const MAX_NOTES = 50;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AssignmentError =
  | "forbidden"
  | "not_found"
  | "invalid_assignee"
  | "invalid_due"
  | "missing_assignee"
  | "invalid_body";

export interface WorkItemAssignment {
  assigneeUserId: string | null;
  assigneeUserName: string | null;
  assigneeRole: string | null;
  assigneeRoleName: string | null;
  dueAt: string | null;
  overdue: boolean;
}

export interface WorkItemNote {
  id: string;
  userId: string;
  userName: string;
  body: string;
  createdAt: string;
}

async function readableItem(authz: Authz, itemId: string): Promise<boolean> {
  const access = await loadWorkItemAccess(authz.user.orgId, itemId);
  // Pack visibility first, then the actor's subsidiary scope over the
  // subject: a restricted caller reads (and writes, through the gates
  // below) only in-scope account-subject findings. Null lineage fails
  // closed, and every denial answers like a missing item.
  return (
    !!access &&
    canReadContinuousCloseAgent(authz, access.agentKey) &&
    subsidiaryScopeAllows(authz.allowedSubsidiaryIds, access.subjectSubsidiaryId)
  );
}

async function resolveAssignee(
  orgId: string,
  assigneeUserId: string | null | undefined,
  assigneeRole: string | null | undefined,
): Promise<{ userId: string | null; roleId: string | null } | null> {
  let userId: string | null = null;
  let roleId: string | null = null;
  // Shape-check before querying: a non-UUID id would die in the driver with
  // a 22P02 throw instead of failing closed as invalid_assignee.
  if (assigneeUserId !== undefined && assigneeUserId !== null) {
    if (typeof assigneeUserId !== "string" || !UUID_RE.test(assigneeUserId)) return null;
    const found = await db.execute<{ id: string }>(sql`
      select id from users where id = ${assigneeUserId} and org_id = ${orgId} and is_active
    `);
    if (found.rows.length === 0) return null;
    userId = String(found.rows[0]?.id);
  }
  if (assigneeRole !== undefined && assigneeRole !== null) {
    if (typeof assigneeRole !== "string" || !UUID_RE.test(assigneeRole)) return null;
    const found = await db.execute<{ id: string }>(sql`
      select id from app_roles where id = ${assigneeRole} and org_id = ${orgId}
    `);
    if (found.rows.length === 0) return null;
    roleId = String(found.rows[0]?.id);
  }
  return { userId, roleId };
}

export async function setWorkItemAssignment(
  authz: Authz,
  itemId: string,
  input: { assigneeUserId?: string | null; assigneeRole?: string | null; dueAt?: string | null },
): Promise<{ ok: true } | { ok: false; error: AssignmentError }> {
  if (!can(authz, "assistant.write")) return { ok: false, error: "forbidden" };
  if (!(await readableItem(authz, itemId))) return { ok: false, error: "not_found" };
  const { assigneeUserId, assigneeRole, dueAt } = input;
  const clearing = (assigneeUserId ?? null) === null && (assigneeRole ?? null) === null && (dueAt ?? null) === null;
  let due: string | null = null;
  if (dueAt !== undefined && dueAt !== null) {
    const parsed = new Date(dueAt);
    if (Number.isNaN(parsed.getTime())) return { ok: false, error: "invalid_due" };
    due = parsed.toISOString();
  }
  if (!clearing && (assigneeUserId ?? null) === null && (assigneeRole ?? null) === null) {
    return { ok: false, error: "missing_assignee" };
  }
  const resolved = await resolveAssignee(authz.user.orgId, assigneeUserId, assigneeRole);
  if (!resolved) return { ok: false, error: "invalid_assignee" };
  const touched = await db.transaction(async (tx) => {
    const changed = await tx.execute<{ id: string }>(sql`
      update ai_work_items set
        assignee_user_id = ${resolved.userId},
        assignee_role = ${resolved.roleId},
        due_at = ${due}::timestamptz,
        updated_at = now(), updated_by = ${authz.user.id}
       where id = ${itemId} and org_id = ${authz.user.orgId}
       returning id
    `);
    if (changed.rows.length === 0) return false;
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${authz.user.orgId}, 'ai_work_items', ${itemId}, 'update',
              ${JSON.stringify({ action: "assign", assigneeUserId: resolved.userId, assigneeRole: resolved.roleId, dueAt: due })}::jsonb,
              ${authz.user.id})
    `);
    return true;
  });
  if (!touched) return { ok: false, error: "not_found" };
  return { ok: true };
}

export async function addWorkItemNote(
  authz: Authz,
  itemId: string,
  body: unknown,
): Promise<{ ok: true; id: string } | { ok: false; error: AssignmentError }> {
  if (!can(authz, "assistant.write")) return { ok: false, error: "forbidden" };
  if (!(await readableItem(authz, itemId))) return { ok: false, error: "not_found" };
  const text = typeof body === "string" ? body.trim() : "";
  if (!text || text.length > MAX_NOTE_CHARS) return { ok: false, error: "invalid_body" };
  const inserted = await db.execute<{ id: string }>(sql`
    insert into ai_work_item_notes (org_id, work_item_id, user_id, body)
    values (${authz.user.orgId}, ${itemId}, ${authz.user.id}, ${text})
    returning id
  `);
  return { ok: true, id: String(inserted.rows[0]?.id) };
}

export async function loadWorkItemAssignment(
  authz: Authz,
  itemId: string,
): Promise<WorkItemAssignment | null> {
  if (!(await readableItem(authz, itemId))) return null;
  const result = await db.execute<{
    assignee_user_id: string | null;
    assignee_user_name: string | null;
    assignee_role: string | null;
    assignee_role_name: string | null;
    due_at: string | Date | null;
  }>(sql`
    select w.assignee_user_id, u.name as assignee_user_name,
           w.assignee_role, r.name as assignee_role_name, w.due_at
      from ai_work_items w
      left join users u on u.id = w.assignee_user_id and u.org_id = w.org_id
      left join app_roles r on r.id::text = w.assignee_role and r.org_id = w.org_id
     where w.id = ${itemId} and w.org_id = ${authz.user.orgId}
  `);
  const row = result.rows[0];
  if (!row) return null;
  const dueAt = row.due_at ? new Date(row.due_at).toISOString() : null;
  return {
    assigneeUserId: row.assignee_user_id ? String(row.assignee_user_id) : null,
    assigneeUserName: row.assignee_user_name ? String(row.assignee_user_name) : null,
    assigneeRole: row.assignee_role ? String(row.assignee_role) : null,
    assigneeRoleName: row.assignee_role_name ? String(row.assignee_role_name) : null,
    dueAt,
    overdue: !!dueAt && new Date(dueAt).getTime() < Date.now(),
  };
}

export async function listWorkItemNotes(authz: Authz, itemId: string): Promise<WorkItemNote[]> {
  if (!(await readableItem(authz, itemId))) return [];
  const result = await db.execute<{
    id: string;
    user_id: string;
    user_name: string | null;
    body: string;
    created_at: string | Date;
  }>(sql`
    select n.id, n.user_id, u.name as user_name, n.body, n.created_at
      from ai_work_item_notes n
      left join users u on u.id = n.user_id and u.org_id = n.org_id
     where n.work_item_id = ${itemId} and n.org_id = ${authz.user.orgId}
     order by n.created_at, n.id
     limit ${MAX_NOTES + 1}
  `);
  return result.rows.slice(0, MAX_NOTES).map((row) => ({
    id: String(row.id),
    userId: String(row.user_id),
    userName: row.user_name ? String(row.user_name) : "Unknown",
    body: String(row.body),
    createdAt: new Date(row.created_at).toISOString(),
  }));
}

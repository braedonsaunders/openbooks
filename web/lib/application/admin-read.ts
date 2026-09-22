import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { clamp } from "../list-params";
import type { ApplicationContext } from "./context";
import { assertApplicationPermission } from "./context";
import { ApplicationError } from "./errors";

/**
 * The company audit log spans deleted rows whose subsidiary cannot be
 * inferred. A restricted allowlist must never authorize it and must never
 * look like an empty log. The remedy is the same unrestricted-visibility
 * grant the audit page already requires (`admin/audit/view.ts`).
 */
export const ADMIN_AUDIT_ORG_WIDE_REFUSAL =
  "the audit log is organization-wide — ask an administrator with unrestricted subsidiary visibility to list it";

function assertUnrestrictedAudit(context: ApplicationContext): void {
  if (context.authz.allowedSubsidiaryIds !== null) {
    throw new ApplicationError("forbidden", ADMIN_AUDIT_ORG_WIDE_REFUSAL, 403);
  }
}

/** Company users — same query shape as `list_users` and /admin/users. Never credentials. */
export async function listApplicationUsers(
  context: ApplicationContext,
  input: { query?: string; status?: string; limit?: number },
) {
  assertApplicationPermission(context, "admin.users.manage");
  const status = input.status ?? "active";
  if (status !== "active" && status !== "inactive" && status !== "all") {
    throw new ApplicationError("invalid_input", "status must be active, inactive, or all", 422);
  }
  const limit = clamp(input.limit ?? 50, 1, 100);
  let where = sql`u.org_id = ${context.authz.user.orgId}`;
  if (input.query?.trim()) {
    const like = `%${input.query.trim()}%`;
    where = sql`${where} and (u.name ilike ${like} or u.email ilike ${like})`;
  }
  if (status !== "all") where = sql`${where} and u.is_active = ${status !== "inactive"}`;
  const [rows, count] = await Promise.all([
    db.execute<Record<string, unknown>>(sql`
      select u.id, u.name, u.email, u.is_active, u.last_login_at,
             coalesce(array_agg(r.name) filter (where r.id is not null), '{}') as roles
        from users u
        left join role_assignments a on a.user_id = u.id and a.org_id = u.org_id
        left join app_roles r on r.id = a.role_id and r.org_id = u.org_id
       where ${where}
       group by u.id
       order by lower(u.name) asc, lower(u.email) asc
       limit ${limit}
    `),
    db.execute<{ n: string }>(sql`select count(*) as n from users u where ${where}`),
  ]);
  return {
    total: Number(count.rows[0]?.n ?? 0),
    users: rows.rows.map((user) => ({
      id: user.id,
      name: user.name,
      email: user.email,
      isActive: user.is_active,
      lastLoginAt: user.last_login_at,
      roles: user.roles,
    })),
  };
}

/** Roles — same query shape as `list_roles` and /admin/roles. */
export async function listApplicationRoles(
  context: ApplicationContext,
  input: { query?: string; type?: string; limit?: number },
) {
  assertApplicationPermission(context, "admin.roles.manage");
  const type = input.type ?? "all";
  if (type !== "built_in" && type !== "custom" && type !== "all") {
    throw new ApplicationError("invalid_input", "type must be built_in, custom, or all", 422);
  }
  const limit = clamp(input.limit ?? 50, 1, 100);
  let where = sql`r.org_id = ${context.authz.user.orgId}`;
  if (input.query?.trim()) {
    const like = `%${input.query.trim()}%`;
    where = sql`${where} and (r.name ilike ${like} or r.description ilike ${like} or r.key ilike ${like})`;
  }
  if (type !== "all") where = sql`${where} and r.is_built_in = ${type === "built_in"}`;
  const [rows, count] = await Promise.all([
    db.execute<Record<string, unknown>>(sql`
      select r.id, r.key, r.name, r.description, r.is_built_in, r.permissions,
             r.subsidiary_restriction,
             coalesce(jsonb_array_length(r.permissions), 0)::int as permission_count,
             (select count(*)::int from role_assignments a
               where a.role_id = r.id and a.org_id = r.org_id) as member_count
        from app_roles r
       where ${where}
       order by r.is_built_in desc, lower(r.name) asc
       limit ${limit}
    `),
    db.execute<{ n: string }>(sql`select count(*) as n from app_roles r where ${where}`),
  ]);
  return {
    total: Number(count.rows[0]?.n ?? 0),
    roles: rows.rows.map((role) => ({
      id: role.id,
      key: role.key,
      name: role.name,
      description: role.description,
      isBuiltIn: role.is_built_in,
      permissions: role.permissions,
      permissionCount: role.permission_count,
      memberCount: role.member_count,
      subsidiaryRestriction: role.subsidiary_restriction,
    })),
  };
}

/** Company audit log — same record-type expression as /admin/audit. */
export async function listApplicationAuditEvents(
  context: ApplicationContext,
  input: {
    query?: string;
    action?: string;
    recordType?: string;
    actorId?: string;
    from?: string;
    to?: string;
    limit?: number;
  },
) {
  assertApplicationPermission(context, "admin.audit.read");
  assertUnrestrictedAudit(context);
  if (input.from && !/^\d{4}-\d{2}-\d{2}$/.test(input.from)) {
    throw new ApplicationError("invalid_input", "from must be YYYY-MM-DD", 422);
  }
  if (input.to && !/^\d{4}-\d{2}-\d{2}$/.test(input.to)) {
    throw new ApplicationError("invalid_input", "to must be YYYY-MM-DD", 422);
  }
  const limit = clamp(input.limit ?? 25, 1, 50);
  const rtypeExpr = sql`case when a.table_name = 'documents'
    then coalesce(d.kind, a.changes #>> '{before,document,kind}', 'documents')
    else a.table_name end`;
  const auditFrom = sql`
    from audit_log a
    left join users u on u.id = a.actor_id and u.org_id = a.org_id
    left join documents d on a.table_name = 'documents' and d.id = a.row_id and d.org_id = a.org_id`;
  let where = sql`a.org_id = ${context.authz.user.orgId}`;
  if (input.action) where = sql`${where} and a.action = ${input.action}`;
  if (input.recordType) where = sql`${where} and (${rtypeExpr}) = ${input.recordType}`;
  if (input.actorId) {
    where = input.actorId === "system"
      ? sql`${where} and a.actor_id is null`
      : sql`${where} and a.actor_id = ${input.actorId}`;
  }
  if (input.from) where = sql`${where} and a.at >= ${input.from}::date`;
  if (input.to) where = sql`${where} and a.at < (${input.to}::date + interval '1 day')`;
  if (input.query?.trim()) {
    const q = input.query.trim();
    const like = `%${q}%`;
    where = sql`${where} and ((${rtypeExpr}) ilike ${like} or u.name ilike ${like} or a.row_id::text = ${q})`;
  }
  const [rows, count] = await Promise.all([
    db.execute<Record<string, unknown>>(sql`
      select a.id, a.row_id, a.action, a.at, u.name as actor_name, (${rtypeExpr}) as rtype, a.changes,
             case
               when a.changes ? 'before' or a.changes ? 'after' then 'snapshot'
               when a.changes ->> 'source' = 'record_metadata' then 'metadata'
               else 'fields'
             end as summary_kind
        ${auditFrom}
       where ${where}
       order by a.at desc
       limit ${limit}
    `),
    db.execute<{ n: string }>(sql`select count(*) as n ${auditFrom} where ${where}`),
  ]);
  return {
    total: Number(count.rows[0]?.n ?? 0),
    events: rows.rows.map((event) => ({
      id: event.id,
      rowId: event.row_id,
      recordType: event.rtype,
      action: event.action,
      actor: event.actor_name,
      at: event.at,
      summaryKind: event.summary_kind,
      changes: event.changes,
    })),
  };
}

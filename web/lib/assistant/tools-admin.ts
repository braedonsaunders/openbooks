import "server-only";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { isFeatureEnabled } from "../features";
import type { AssistantToolDef, ToolResult } from "./types";
import { capList, dateInput, uuidInput } from "./tools-shared";

/**
 * Administration read tools for the agentic assistant. Each mirrors its
 * admin page's gate and query shape (`web/app/(app)/admin/{users,roles,
 * api-keys,audit}/view.ts`): users with role assignments, roles with their
 * permission sets and member counts, API keys as metadata only (the page's
 * explicit column list — key hashes and secrets never leave the server), the
 * company audit log with the page's record-type expression, and scheduler +
 * delivery outbox health without job payloads. The audit log and outboxes
 * span deleted records whose scope cannot be inferred, so — like the audit
 * page — they require an org-wide caller.
 */

// Deleted records carry no inferable scope: restricted callers see nothing,
// exactly as the audit page bounces them.
function adminScopeDenied(authz: { allowedSubsidiaryIds: Set<string> | null }): ToolResult | null {
  return authz.allowedSubsidiaryIds === null ? null : { ok: false, error: "forbidden" };
}

const listUsers: AssistantToolDef = {
  name: "list_users",
  description:
    "Company users: name, email, active state, last login, and assigned role names. Optionally filter by name/email text or active state. Never includes credentials. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["admin.users.manage"] },
  inputSchema: z.object({
    q: z.string().max(100).optional().describe("Filter by name or email"),
    status: z.enum(["active", "inactive", "all"]).optional().describe("Active state filter, default active"),
    limit: z.number().int().min(1).max(100).optional().describe("Max rows, default 50"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as { q?: string; status?: string; limit?: number };
    const limit = Math.min(a.limit ?? 50, 100);
    let where = sql`u.org_id = ${authz.user.orgId}`;
    if (a.q) where = sql`${where} and (u.name ilike ${"%" + a.q + "%"} or u.email ilike ${"%" + a.q + "%"})`;
    if ((a.status ?? "active") !== "all") where = sql`${where} and u.is_active = ${a.status !== "inactive"}`;
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
    const total = Number(count.rows[0]?.n ?? 0);
    const { items, truncated } = capList(
      rows.rows.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        isActive: u.is_active,
        lastLoginAt: u.last_login_at,
        roles: u.roles,
      })),
      limit,
    );
    return {
      ok: true,
      data: { total, returned: items.length, truncated: truncated || total > items.length, users: items, href: "/admin/users" },
    };
  },
};

const listRoles: AssistantToolDef = {
  name: "list_roles",
  description:
    "Roles with their permission sets, built-in flag, member counts, and subsidiary restriction. Use it to answer who can do what before changing anything (changes go through the admin Roles page). Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["admin.roles.manage"] },
  inputSchema: z.object({
    q: z.string().max(100).optional().describe("Filter by name, description, or key"),
    type: z.enum(["built_in", "custom", "all"]).optional().describe("Role type filter, default all"),
    limit: z.number().int().min(1).max(100).optional().describe("Max rows, default 50"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as { q?: string; type?: string; limit?: number };
    const limit = Math.min(a.limit ?? 50, 100);
    let where = sql`r.org_id = ${authz.user.orgId}`;
    if (a.q) {
      where = sql`${where} and (r.name ilike ${"%" + a.q + "%"} or r.description ilike ${"%" + a.q + "%"} or r.key ilike ${"%" + a.q + "%"})`;
    }
    if (a.type && a.type !== "all") where = sql`${where} and r.is_built_in = ${a.type === "built_in"}`;
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
    const total = Number(count.rows[0]?.n ?? 0);
    const { items, truncated } = capList(
      rows.rows.map((r) => ({
        id: r.id,
        key: r.key,
        name: r.name,
        description: r.description,
        isBuiltIn: r.is_built_in,
        permissions: r.permissions,
        permissionCount: r.permission_count,
        memberCount: r.member_count,
        subsidiaryRestriction: r.subsidiary_restriction,
      })),
      limit,
    );
    return {
      ok: true,
      data: { total, returned: items.length, truncated: truncated || total > items.length, roles: items, href: "/admin/roles" },
    };
  },
};

const listApiKeys: AssistantToolDef = {
  name: "list_api_keys",
  description:
    "API key metadata: name, owner, scopes, rate limit, active state, expiry, last use. Key material (hashes, secrets) is never returned — only the prefix and preview. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["api.keys.manage"] },
  feature: "apiAccess",
  inputSchema: z.object({
    q: z.string().max(100).optional().describe("Filter by key name, owner name, or owner email"),
    limit: z.number().int().min(1).max(100).optional().describe("Max rows, default 50"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!(await isFeatureEnabled(authz.user.orgId, "apiAccess"))) {
      return { ok: false, error: "api_access_feature_disabled" };
    }
    const a = raw as { q?: string; limit?: number };
    const limit = Math.min(a.limit ?? 50, 100);
    // The page's explicit column list: hashes and secrets stay server-side.
    let where = sql`k.org_id = ${authz.user.orgId}`;
    if (a.q) {
      where = sql`${where} and (k.name ilike ${"%" + a.q + "%"} or u.name ilike ${"%" + a.q + "%"} or u.email ilike ${"%" + a.q + "%"})`;
    }
    const [rows, count] = await Promise.all([
      db.execute<Record<string, unknown>>(sql`
        select k.id, k.name, k.description, k.key_prefix, k.key_preview, k.scopes,
               k.rate_limit_per_min, k.is_active, k.expires_at, k.last_used_at, k.created_at,
               u.name as owner_name, u.email as owner_email
          from api_keys k
          join users u on u.id = k.user_id
         where ${where}
         order by k.created_at desc
         limit ${limit}
      `),
      db.execute<{ n: string }>(sql`
        select count(*) as n from api_keys k
          join users u on u.id = k.user_id
         where ${where}
      `),
    ]);
    const total = Number(count.rows[0]?.n ?? 0);
    const { items, truncated } = capList(
      rows.rows.map((k) => ({
        id: k.id,
        name: k.name,
        description: k.description,
        keyPrefix: k.key_prefix,
        keyPreview: k.key_preview,
        scopes: k.scopes,
        rateLimitPerMin: k.rate_limit_per_min,
        isActive: k.is_active,
        expiresAt: k.expires_at,
        lastUsedAt: k.last_used_at,
        createdAt: k.created_at,
        ownerName: k.owner_name,
        ownerEmail: k.owner_email,
      })),
      limit,
    );
    return {
      ok: true,
      data: { total, returned: items.length, truncated: truncated || total > items.length, keys: items, href: "/admin/api-keys" },
    };
  },
};

const searchAuditLog: AssistantToolDef = {
  name: "search_audit_log",
  description:
    "Search the company audit log: actions, record types, actors, dates, free text. Rows carry each event's change summary plus full changes payload. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["admin.audit.read"] },
  inputSchema: z.object({
    q: z.string().max(100).optional().describe("Free text over record type, actor name, or row id"),
    action: z.string().max(30).optional().describe("Action code, e.g. post, void, approve"),
    rtype: z.string().max(80).optional().describe("Record type, e.g. customer_invoice, journal_entry"),
    actorId: z.union([uuidInput, z.literal("system")]).optional().describe("Only events by this user; the literal system selects system events"),
    from: dateInput.optional().describe("Events on or after this date"),
    to: dateInput.optional().describe("Events before this date"),
    limit: z.number().int().min(1).max(50).optional().describe("Max rows, default 25"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const denied = adminScopeDenied(authz);
    if (denied) return denied;
    const a = raw as { q?: string; action?: string; rtype?: string; actorId?: string; from?: string; to?: string; limit?: number };
    const limit = Math.min(a.limit ?? 25, 50);
    // The page's record-type expression: the raw table for most rows, the
    // document kind for the shared documents table, recovered from the
    // before snapshot for deleted documents.
    const rtypeExpr = sql`case when a.table_name = 'documents'
      then coalesce(d.kind, a.changes #>> '{before,document,kind}', 'documents')
      else a.table_name end`;
    const auditFrom = sql`
      from audit_log a
      left join users u on u.id = a.actor_id and u.org_id = a.org_id
      left join documents d on a.table_name = 'documents' and d.id = a.row_id and d.org_id = a.org_id`;
    let where = sql`a.org_id = ${authz.user.orgId}`;
    if (a.action) where = sql`${where} and a.action = ${a.action}`;
    if (a.rtype) where = sql`${where} and (${rtypeExpr}) = ${a.rtype}`;
    if (a.actorId) {
      where = a.actorId === "system"
        ? sql`${where} and a.actor_id is null`
        : sql`${where} and a.actor_id = ${a.actorId}`;
    }
    if (a.from) where = sql`${where} and a.at >= ${a.from}::date`;
    if (a.to) where = sql`${where} and a.at < (${a.to}::date + interval '1 day')`;
    if (a.q) {
      where = sql`${where} and ((${rtypeExpr}) ilike ${"%" + a.q + "%"} or u.name ilike ${"%" + a.q + "%"} or a.row_id::text = ${a.q})`;
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
    const total = Number(count.rows[0]?.n ?? 0);
    const { items, truncated } = capList(
      rows.rows.map((e) => ({
        id: e.id,
        rowId: e.row_id,
        recordType: e.rtype,
        action: e.action,
        actor: e.actor_name,
        at: e.at,
        summaryKind: e.summary_kind,
        changes: e.changes,
      })),
      limit,
    );
    return {
      ok: true,
      data: { total, returned: items.length, truncated: truncated || total > items.length, events: items, href: "/admin/audit" },
    };
  },
};

const getOutboxStatus: AssistantToolDef = {
  name: "get_outbox_status",
  description:
    "Background-work health: scheduler and report-delivery outboxes by status, oldest pending age, recent failures. Payloads stay server-side. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["admin.audit.read"] },
  inputSchema: z.object({}),
  execute: async (_raw, authz): Promise<ToolResult> => {
    const denied = adminScopeDenied(authz);
    if (denied) return denied;
    const [scheduled, deliveries, failures] = await Promise.all([
      db.execute<{ status: string; n: string; oldest_pending_at: string | null }>(sql`
        select status, count(*)::text as n, min(case when status = 'pending' then created_at end) as oldest_pending_at
          from scheduler_outbox
         where org_id = ${authz.user.orgId}
         group by status
      `),
      db.execute<{ status: string; n: string; oldest_pending_at: string | null }>(sql`
        select status, count(*)::text as n, min(case when status = 'pending' then created_at end) as oldest_pending_at
          from report_delivery_outbox
         where org_id = ${authz.user.orgId}
         group by status
      `),
      db.execute<Record<string, unknown>>(sql`
        (select kind as job, status, attempt_count, error, created_at, updated_at
           from scheduler_outbox
          where org_id = ${authz.user.orgId} and status = 'failed'
          order by updated_at desc limit 5)
        union all
        (select recipient as job, status, attempt_count, error, created_at, updated_at
           from report_delivery_outbox
          where org_id = ${authz.user.orgId} and status = 'failed'
          order by updated_at desc limit 5)
        order by updated_at desc limit 10
      `),
    ]);
    const summarize = (rows: { status: string; n: string; oldest_pending_at: string | null }[]) => {
      const byStatus: Record<string, number> = {};
      let oldestPendingAt: string | null = null;
      for (const row of rows) {
        byStatus[row.status] = Number(row.n);
        oldestPendingAt = row.oldest_pending_at ?? oldestPendingAt;
      }
      return { byStatus, oldestPendingAt };
    };
    return {
      ok: true,
      data: {
        scheduler: summarize(scheduled.rows),
        deliveries: summarize(deliveries.rows),
        recentFailures: failures.rows.map((f) => ({
          job: f.job,
          status: f.status,
          attempts: f.attempt_count,
          error: typeof f.error === "string" ? f.error.slice(0, 500) : f.error,
          createdAt: f.created_at,
          updatedAt: f.updated_at,
        })),
        href: "/admin/audit",
      },
    };
  },
};

export const ADMIN_TOOLS: AssistantToolDef[] = [
  listUsers,
  listRoles,
  listApiKeys,
  searchAuditLog,
  getOutboxStatus,
];

import "server-only";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import type { Authz } from "../authz";
import type { AssistantToolDef, ToolResult } from "./types";
import { capList, uuidInput } from "./tools-shared";

/**
 * Period-close read tools for the agentic assistant. They mirror the close
 * cockpit (`web/app/(app)/close/view.ts`, gated `close.read`): the same
 * run/task/exception/signoff/lock query shapes, the same org-wide scope rule
 * (`guardCloseScope` in `web/lib/close-scope.ts` — close diagnostics span the
 * organization, so a restricted-subsidiary caller sees nothing, exactly as
 * the page and the runs API 404 them), and the same hrefs.
 */

// Close diagnostics span the organization: a selected subsidiary must never
// authorize them (guardCloseScope). Fail closed like the page does. Shared
// with the FX consolidation view, which is the same org-wide surface.
export function closeScopeDenied(authz: Authz): ToolResult | null {
  return authz.allowedSubsidiaryIds === null ? null : { ok: false, error: "forbidden" };
}

const getCloseRunStatus: AssistantToolDef = {
  name: "get_close_run_status",
  description:
    "One period-close run's cockpit state: period and book, lifecycle status and stage, readiness score, task counts by status, open exceptions (most severe first), sign-offs, and the period locks for the run's period and book. Use list_close_runs for the runs in flight, then this for the detail. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["close.read"] },
  inputSchema: z.object({ runId: uuidInput }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const denied = closeScopeDenied(authz);
    if (denied) return denied;
    const a = raw as { runId: string };
    const [runRes, taskRes, exceptionRes, signoffRes] = await Promise.all([
      db.execute<Record<string, unknown>>(sql`
        select r.id, r.status, r.current_stage, r.readiness_score, r.target_close_date,
               r.started_at, r.last_validated_at,
               p.id as period_id, p.name as period_name, p.starts_on, p.ends_on, p.fiscal_year,
               b.id as book_id, b.name as book_name, b.code as book_code,
               starter.name as started_by_name
          from close_runs r
          join accounting_periods p on p.id = r.period_id and p.org_id = r.org_id
          join accounting_books b on b.id = r.book_id and b.org_id = r.org_id
          left join users starter on starter.id = r.started_by
         where r.id = ${a.runId} and r.org_id = ${authz.user.orgId}
      `),
      db.execute<{ status: string; n: string }>(sql`
        select status, count(*)::text as n
          from close_run_tasks
         where run_id = ${a.runId} and org_id = ${authz.user.orgId}
         group by status
      `),
      db.execute<Record<string, unknown>>(sql`
        select code, category, severity, status, title, message, created_at
          from close_exceptions
         where run_id = ${a.runId} and org_id = ${authz.user.orgId} and status = 'open'
         order by case severity when 'critical' then 1 when 'error' then 2 when 'warning' then 3 else 4 end,
                  created_at
         limit 10
      `),
      db.execute<Record<string, unknown>>(sql`
        select s.signoff_type, s.decision, s.signed_at, u.name as signed_by_name
          from close_signoffs s join users u on u.id = s.signed_by
         where s.run_id = ${a.runId} and s.org_id = ${authz.user.orgId}
         order by s.signed_at desc
      `),
    ]);
    const run = runRes.rows[0];
    if (!run) return { ok: false, error: "close_run_not_found" };
    const locks = (await db.execute<Record<string, unknown>>(sql`
      select l.module, l.state, l.reopen_expires_at, l.locked_at, l.reason,
             s.name as subsidiary_name
        from period_locks l
        left join subsidiaries s on s.id = l.subsidiary_id and s.org_id = l.org_id
       where l.org_id = ${authz.user.orgId}
         and l.period_id = ${run.period_id as string}
         and l.book_id = ${run.book_id as string}
       order by l.subsidiary_id nulls first, l.module
    `));
    const tasksByStatus: Record<string, number> = {};
    for (const row of taskRes.rows) tasksByStatus[row.status] = Number(row.n);
    return {
      ok: true,
      data: {
        id: run.id,
        period: { id: run.period_id, name: run.period_name, startsOn: run.starts_on, endsOn: run.ends_on, fiscalYear: run.fiscal_year },
        book: { id: run.book_id, name: run.book_name, code: run.book_code },
        status: run.status,
        currentStage: run.current_stage,
        readinessScore: run.readiness_score,
        targetCloseDate: run.target_close_date,
        startedAt: run.started_at,
        startedBy: run.started_by_name,
        lastValidatedAt: run.last_validated_at,
        tasksByStatus,
        openExceptions: exceptionRes.rows.map((e) => ({
          code: e.code,
          category: e.category,
          severity: e.severity,
          status: e.status,
          title: e.title,
          message: e.message,
          createdAt: e.created_at,
        })),
        signoffs: signoffRes.rows.map((s) => ({
          type: s.signoff_type,
          decision: s.decision,
          signedBy: s.signed_by_name,
          signedAt: s.signed_at,
        })),
        locks: locks.rows.map((l) => ({
          module: l.module,
          state: l.state,
          subsidiary: l.subsidiary_name,
          reopenExpiresAt: l.reopen_expires_at,
          lockedAt: l.locked_at,
          reason: l.reason,
        })),
        href: `/close?run=${a.runId}`,
      },
    };
  },
};

const listPeriodLocks: AssistantToolDef = {
  name: "list_period_locks",
  description:
    "List period locks by scope: period, book, subsidiary (null means org-wide), module (ar, ap, banking, assets, tax, gl), state (open, soft_closed, closed), who locked it, why, and any time-bounded reopen expiry. Optionally filter by period, state, or module. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["close.read"] },
  inputSchema: z.object({
    periodId: uuidInput.optional(),
    state: z.enum(["open", "soft_closed", "closed"]).optional().describe("Only locks in this state"),
    module: z.enum(["ar", "ap", "banking", "assets", "tax", "gl"]).optional().describe("Only locks for this module"),
    limit: z.number().int().min(1).max(200).optional().describe("Maximum locks to return (default 50)"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const denied = closeScopeDenied(authz);
    if (denied) return denied;
    const a = raw as { periodId?: string; state?: string; module?: string; limit?: number };
    const limit = Math.min(a.limit ?? 50, 200);
    let where = sql`l.org_id = ${authz.user.orgId}`;
    if (a.periodId) where = sql`${where} and l.period_id = ${a.periodId}`;
    if (a.state) where = sql`${where} and l.state = ${a.state}`;
    if (a.module) where = sql`${where} and l.module = ${a.module}`;
    const [rows, count] = await Promise.all([
      db.execute<Record<string, unknown>>(sql`
        select l.id, l.module, l.state, l.locked_at, l.reason, l.reopen_expires_at,
               p.name as period_name, p.starts_on, p.ends_on,
               b.name as book_name, b.code as book_code,
               s.name as subsidiary_name,
               u.name as locked_by_name
          from period_locks l
          join accounting_periods p on p.id = l.period_id and p.org_id = l.org_id
          join accounting_books b on b.id = l.book_id and b.org_id = l.org_id
          left join subsidiaries s on s.id = l.subsidiary_id and s.org_id = l.org_id
          left join users u on u.id = l.locked_by
         where ${where}
         order by p.ends_on desc, l.subsidiary_id nulls first, l.module
         limit ${limit}
      `),
      db.execute<{ n: string }>(sql`
        select count(*) as n from period_locks l where ${where}
      `),
    ]);
    const total = Number(count.rows[0]?.n ?? 0);
    const { items, truncated } = capList(
      rows.rows.map((l) => ({
        id: l.id,
        period: l.period_name,
        periodStartsOn: l.starts_on,
        periodEndsOn: l.ends_on,
        book: l.book_name,
        bookCode: l.book_code,
        subsidiary: l.subsidiary_name,
        module: l.module,
        state: l.state,
        lockedAt: l.locked_at,
        lockedBy: l.locked_by_name,
        reason: l.reason,
        reopenExpiresAt: l.reopen_expires_at,
      })),
      limit,
    );
    return {
      ok: true,
      data: { total, returned: items.length, truncated: truncated || total > items.length, locks: items, href: "/close" },
    };
  },
};

const listPeriodReopenRequests: AssistantToolDef = {
  name: "list_period_reopen_requests",
  description:
    "List period-reopen requests: period, book, subsidiary scope, modules, reason, status (requested, approved, rejected, expired, reclosed), requester and approver, and expiry. Requesting and deciding go through request_period_reopen / decide_period_reopen. Read-only.",
  category: "search",
  // No close.read list surface shows these rows: requesting/deciding live
  // behind close.reopen (admin/close route) and the setup surface behind
  // periods.manage, so the read side admits exactly those two (flagged for
  // the permission-parity audit).
  gate: { mode: "anyOf", perms: ["close.reopen", "periods.manage"] },
  inputSchema: z.object({
    status: z.enum(["requested", "approved", "rejected", "expired", "reclosed"]).optional().describe("Only requests in this status"),
    periodId: uuidInput.optional(),
    limit: z.number().int().min(1).max(100).optional().describe("Maximum requests to return (default 50)"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const denied = closeScopeDenied(authz);
    if (denied) return denied;
    const a = raw as { status?: string; periodId?: string; limit?: number };
    const limit = Math.min(a.limit ?? 50, 100);
    let where = sql`r.org_id = ${authz.user.orgId}`;
    if (a.status) where = sql`${where} and r.status = ${a.status}`;
    if (a.periodId) where = sql`${where} and r.period_id = ${a.periodId}`;
    const [rows, count] = await Promise.all([
      db.execute<Record<string, unknown>>(sql`
        select r.id, r.modules, r.reason, r.status, r.expires_at, r.reclosed_at, r.created_at,
               p.name as period_name, b.name as book_name, b.code as book_code,
               s.name as subsidiary_name,
               req.name as requested_by_name, app.name as approved_by_name, r.approved_at
          from close_reopen_requests r
          join accounting_periods p on p.id = r.period_id and p.org_id = r.org_id
          join accounting_books b on b.id = r.book_id and b.org_id = r.org_id
          left join subsidiaries s on s.id = r.subsidiary_id and s.org_id = r.org_id
          left join users req on req.id = r.requested_by
          left join users app on app.id = r.approved_by
         where ${where}
         order by r.created_at desc
         limit ${limit}
      `),
      db.execute<{ n: string }>(sql`
        select count(*) as n from close_reopen_requests r where ${where}
      `),
    ]);
    const total = Number(count.rows[0]?.n ?? 0);
    const { items, truncated } = capList(
      rows.rows.map((r) => ({
        id: r.id,
        period: r.period_name,
        book: r.book_name,
        bookCode: r.book_code,
        subsidiary: r.subsidiary_name,
        modules: r.modules,
        reason: r.reason,
        status: r.status,
        requestedBy: r.requested_by_name,
        approvedBy: r.approved_by_name,
        approvedAt: r.approved_at,
        expiresAt: r.expires_at,
        reclosedAt: r.reclosed_at,
        createdAt: r.created_at,
      })),
      limit,
    );
    return {
      ok: true,
      data: { total, returned: items.length, truncated: truncated || total > items.length, requests: items, href: "/close" },
    };
  },
};

export const CLOSE_TOOLS: AssistantToolDef[] = [
  getCloseRunStatus,
  listPeriodLocks,
  listPeriodReopenRequests,
];

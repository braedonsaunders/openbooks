import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { attestOwnerManagedClose, requestCloseApproval } from "@openbooks/engine/src/close/approvals.ts";
import { closeApprovedRun, publishCloseRun } from "@openbooks/engine/src/close/run-completion.ts";
import { CloseError, type CloseModule } from "@openbooks/engine/src/close/period-policy.ts";
import { decidePeriodReopen, requestPeriodReopen } from "@openbooks/engine/src/close/reopening.ts";
import { refreshCloseRun } from "@openbooks/engine/src/close/run-automation.ts";
import { startCloseRun } from "@openbooks/engine/src/close/run-start.ts";
import {
  RevaluationError,
  RevaluationFeatureDisabledError,
  runRevaluation,
} from "@openbooks/engine/src/close/fx-revaluation.ts";
import type { ApplicationContext } from "./context";
import { assertApplicationPermission, assertSubsidiaryAccess } from "./context";
import { ApplicationError, notFound } from "./errors";
import { isFeatureEnabled } from "../features";
import { executeIdempotent } from "./idempotency";

/**
 * Close diagnostics (run lists, period locks, reopen queues) span the
 * organization. A restricted subsidiary allowlist must never authorize them
 * and must never look like "no runs". The remedy is the same role write the
 * unrestricted half of close-lifecycle-authz already exercises: set the
 * caller's subsidiary restriction to all organizations.
 */
export const CLOSE_ORG_WIDE_DIAGNOSTICS_REFUSAL =
  "close diagnostics are organization-wide — ask an administrator with unrestricted subsidiary visibility to list them";

function assertUnrestrictedCloseDiagnostics(context: ApplicationContext): void {
  if (context.authz.allowedSubsidiaryIds !== null) {
    throw new ApplicationError("forbidden", CLOSE_ORG_WIDE_DIAGNOSTICS_REFUSAL, 403);
  }
}
type CloseRunRow = {
  id: string;
  periodId: string;
  periodName: string;
  bookId: string;
  bookCode: string;
  status: string;
  currentStage: string;
  targetCloseDate: string;
  scope: { subsidiaryIds?: string[] } | null;
  startedAt: Date;
  lastValidatedAt: Date | null;
};

function mapCloseError(error: unknown): never {
  if (error instanceof CloseError) {
    throw new ApplicationError("invalid_input", error.message, 422);
  }
  throw error;
}

async function closeRun(context: ApplicationContext, runId: string): Promise<CloseRunRow> {
  assertSubsidiaryAccess(context, null);
  const result = (await db.execute<CloseRunRow>(sql`
    select r.id, r.period_id as "periodId", p.name as "periodName",
           r.book_id as "bookId", b.code as "bookCode", r.status,
           r.current_stage as "currentStage", r.target_close_date as "targetCloseDate",
           r.scope, r.started_at as "startedAt", r.last_validated_at as "lastValidatedAt"
      from close_runs r
      join accounting_periods p on p.id = r.period_id and p.org_id = r.org_id
      join accounting_books b on b.id = r.book_id and b.org_id = r.org_id
     where r.id = ${runId} and r.org_id = ${context.authz.user.orgId}
     limit 1
  `));
  const row = result.rows[0];
  if (!row) throw notFound("close run");
  return row;
}

export async function listCloseRuns(
  context: ApplicationContext,
  input: { status?: string; limit?: number },
): Promise<CloseRunRow[]> {
  assertApplicationPermission(context, "close.run");
  // Declared lock targets do not narrow the organization-wide diagnostics.
  assertUnrestrictedCloseDiagnostics(context);
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  const result = (await db.execute<CloseRunRow>(sql`
    select r.id, r.period_id as "periodId", p.name as "periodName",
           r.book_id as "bookId", b.code as "bookCode", r.status,
           r.current_stage as "currentStage", r.target_close_date as "targetCloseDate",
           r.scope, r.started_at as "startedAt", r.last_validated_at as "lastValidatedAt"
      from close_runs r
      join accounting_periods p on p.id = r.period_id and p.org_id = r.org_id
      join accounting_books b on b.id = r.book_id and b.org_id = r.org_id
     where r.org_id = ${context.authz.user.orgId}
       ${input.status ? sql`and r.status = ${input.status}` : sql``}
     order by p.ends_on desc, r.started_at desc
     limit ${limit}
  `));
  return result.rows;
}

const LOCK_STATES = new Set(["open", "soft_closed", "closed"]);
const LOCK_MODULES = new Set(["ar", "ap", "banking", "assets", "tax", "gl"]);

/** Period locks — same query shape as `list_period_locks`. Org-wide diagnostics. */
export async function listPeriodLocks(
  context: ApplicationContext,
  input: { periodId?: string; state?: string; module?: string; limit?: number },
) {
  assertApplicationPermission(context, "close.read");
  assertUnrestrictedCloseDiagnostics(context);
  if (input.state && !LOCK_STATES.has(input.state)) {
    throw new ApplicationError("invalid_input", "state must be open, soft_closed, or closed", 422);
  }
  if (input.module && !LOCK_MODULES.has(input.module)) {
    throw new ApplicationError("invalid_input", "module must be ar, ap, banking, assets, tax, or gl", 422);
  }
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  let where = sql`l.org_id = ${context.authz.user.orgId}`;
  if (input.periodId) where = sql`${where} and l.period_id = ${input.periodId}`;
  if (input.state) where = sql`${where} and l.state = ${input.state}`;
  if (input.module) where = sql`${where} and l.module = ${input.module}`;
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
    db.execute<{ n: string }>(sql`select count(*) as n from period_locks l where ${where}`),
  ]);
  return {
    total: Number(count.rows[0]?.n ?? 0),
    locks: rows.rows.map((lock) => ({
      id: lock.id,
      period: lock.period_name,
      periodStartsOn: lock.starts_on,
      periodEndsOn: lock.ends_on,
      book: lock.book_name,
      bookCode: lock.book_code,
      subsidiary: lock.subsidiary_name,
      module: lock.module,
      state: lock.state,
      lockedAt: lock.locked_at,
      lockedBy: lock.locked_by_name,
      reason: lock.reason,
      reopenExpiresAt: lock.reopen_expires_at,
    })),
  };
}

export async function getCloseRun(context: ApplicationContext, runId: string): Promise<CloseRunRow> {
  assertApplicationPermission(context, "close.run");
  return closeRun(context, runId);
}

export async function startApplicationCloseRun(context: ApplicationContext, input: {
  periodId: string;
  bookId: string;
  blueprintId?: string;
  reportingPackageId?: string;
  targetCloseDate?: string;
  subsidiaryIds?: string[];
  idempotencyKey: string;
}): Promise<{ replayed: boolean; result: { runId: string } }> {
  assertApplicationPermission(context, "close.run");
  assertSubsidiaryAccess(context, null);
  const outcome = await executeIdempotent({
    context,
    operation: "close.start",
    idempotencyKey: input.idempotencyKey,
    request: input,
    execute: async () => {
      try {
        return { runId: await startCloseRun({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          periodId: input.periodId,
          bookId: input.bookId,
          blueprintId: input.blueprintId,
          reportingPackageId: input.reportingPackageId,
          targetCloseDate: input.targetCloseDate,
          subsidiaryIds: input.subsidiaryIds,
        }) };
      } catch (error) {
        mapCloseError(error);
      }
    },
  });
  return { replayed: outcome.replayed, result: outcome.value };
}

export async function advanceCloseRun(context: ApplicationContext, input: {
  runId: string;
  action: "refresh" | "request_approval" | "attest" | "close" | "publish";
  comment?: string;
  idempotencyKey: string;
}): Promise<{ replayed: boolean; result: Record<string, unknown> }> {
  assertApplicationPermission(
    context,
    input.action === "attest" || input.action === "close" ? "close.approve" : "close.run",
  );
  if (input.action === "publish" && !(await isFeatureEnabled(context.authz.user.orgId, "advancedClose"))) {
    throw notFound("close package");
  }
  await closeRun(context, input.runId);
  const outcome = await executeIdempotent({
    context,
    operation: `close.${input.action}`,
    idempotencyKey: input.idempotencyKey,
    request: input,
    execute: async (): Promise<Record<string, unknown>> => {
      try {
        if (input.action === "refresh") {
          return { refreshed: true, ...await refreshCloseRun(context.authz.user.orgId, input.runId, context.authz.user.id) };
        }
        if (input.action === "request_approval") {
          await requestCloseApproval(context.authz.user.orgId, input.runId, context.authz.user.id);
        } else if (input.action === "attest") {
          await attestOwnerManagedClose(context.authz.user.orgId, input.runId, context.authz.user.id, input.comment ?? "");
        } else if (input.action === "close") {
          await closeApprovedRun(context.authz.user.orgId, input.runId, context.authz.user.id);
        } else {
          await publishCloseRun(context.authz.user.orgId, input.runId, context.authz.user.id, input.comment);
        }
        return { action: input.action, run: await closeRun(context, input.runId) };
      } catch (error) {
        mapCloseError(error);
      }
    },
  });
  return { replayed: outcome.replayed, result: outcome.value };
}

export async function runPeriodRevaluation(context: ApplicationContext, input: {
  periodId: string;
  bookId?: string;
  idempotencyKey: string;
}): Promise<{ replayed: boolean; result: Record<string, unknown> }> {
  assertApplicationPermission(context, "close.run");
  const allowed = context.authz.allowedSubsidiaryIds;
  // Fail closed before the idempotent execution is recorded: an empty caller
  // scope would otherwise run zero subsidiaries and report success with no
  // observable work. Mirrors the run-revaluation route guard with the same
  // wording; null stays the explicit unrestricted sentinel.
  if (allowed !== null && allowed.size === 0) {
    throw new ApplicationError(
      "forbidden",
      "no subsidiaries are in the caller's close scope — ask an administrator with unrestricted subsidiary visibility to run this close action",
      403,
    );
  }
  const outcome = await executeIdempotent({
    context,
    operation: "close.revaluation.run",
    idempotencyKey: input.idempotencyKey,
    request: {
      periodId: input.periodId,
      bookId: input.bookId ?? null,
      subsidiaryIds: allowed === null ? null : [...allowed].sort(),
    },
    execute: async (): Promise<Record<string, unknown>> => {
      try {
        const run = await runRevaluation(
          context.authz.user.orgId,
          input.periodId,
          context.authz.user.id,
          allowed === null ? undefined : [...allowed],
          input.bookId,
        );
        return { ...run };
      } catch (error) {
        // The route 404s a disabled FX module and 422s request state.
        if (error instanceof RevaluationFeatureDisabledError) throw notFound("revaluation");
        if (error instanceof RevaluationError) {
          throw new ApplicationError("invalid_input", error.message, 422);
        }
        throw error;
      }
    },
  });
  return { replayed: outcome.replayed, result: outcome.value };
}

export async function createReopenRequest(context: ApplicationContext, input: {
  periodId: string;
  bookId: string;
  subsidiaryId?: string;
  modules: CloseModule[];
  reason: string;
  idempotencyKey: string;
}): Promise<{ replayed: boolean; result: { requestId: string } }> {
  assertApplicationPermission(context, "close.reopen");
  assertSubsidiaryAccess(context, null);
  assertSubsidiaryAccess(context, input.subsidiaryId);
  const outcome = await executeIdempotent({
    context, operation: "close.reopen.request", idempotencyKey: input.idempotencyKey, request: input,
    execute: async () => {
      try {
        return { requestId: await requestPeriodReopen({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          periodId: input.periodId,
          bookId: input.bookId,
          subsidiaryId: input.subsidiaryId,
          modules: input.modules,
          reason: input.reason,
        }) };
      } catch (error) { mapCloseError(error); }
    },
  });
  return { replayed: outcome.replayed, result: outcome.value };
}

export async function decideReopenRequest(context: ApplicationContext, input: {
  requestId: string;
  approve: boolean;
  hours?: number;
  idempotencyKey: string;
}): Promise<{ replayed: boolean; result: { requestId: string; approved: boolean } }> {
  assertApplicationPermission(context, "close.reopen");
  assertSubsidiaryAccess(context, null);
  const scope = (await db.execute<{ subsidiaryId: string | null }>(sql`
    select subsidiary_id as "subsidiaryId" from close_reopen_requests
     where id = ${input.requestId} and org_id = ${context.authz.user.orgId}
  `));
  if (!scope.rows[0]) throw notFound("reopen request");
  assertSubsidiaryAccess(context, scope.rows[0].subsidiaryId);
  const outcome = await executeIdempotent({
    context, operation: "close.reopen.decide", idempotencyKey: input.idempotencyKey, request: input,
    execute: async () => {
      try {
        await decidePeriodReopen({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          requestId: input.requestId,
          approve: input.approve,
          hours: input.hours,
        });
        return { requestId: input.requestId, approved: input.approve };
      } catch (error) { mapCloseError(error); }
    },
  });
  return { replayed: outcome.replayed, result: outcome.value };
}

import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import {
  closeApprovedRun,
  CloseError,
  decidePeriodReopen,
  publishCloseRun,
  refreshCloseRun,
  requestCloseApproval,
  requestPeriodReopen,
  startCloseRun,
  type CloseModule,
} from "@openbooks/engine/src/close.ts";
import type { ApplicationContext } from "./context";
import { assertApplicationPermission, assertSubsidiaryAccess } from "./context";
import { ApplicationError, forbidden, notFound } from "./errors";
import { executeIdempotent } from "./idempotency";

interface CloseRunRow {
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
}

function assertCloseSubsidiaries(context: ApplicationContext, subsidiaryIds: string[]): void {
  const allowed = context.authz.allowedSubsidiaryIds;
  if (allowed === null) return;
  if (subsidiaryIds.length === 0 || subsidiaryIds.some((id) => !allowed.has(id))) {
    throw forbidden("close.subsidiary_scope");
  }
}

function mapCloseError(error: unknown): never {
  if (error instanceof CloseError) {
    throw new ApplicationError("invalid_input", error.message, 422);
  }
  throw error;
}

async function closeRun(context: ApplicationContext, runId: string): Promise<CloseRunRow> {
  const result = (await db.execute(sql`
    select r.id, r.period_id as "periodId", p.name as "periodName",
           r.book_id as "bookId", b.code as "bookCode", r.status,
           r.current_stage as "currentStage", r.target_close_date as "targetCloseDate",
           r.scope, r.started_at as "startedAt", r.last_validated_at as "lastValidatedAt"
      from close_runs r
      join accounting_periods p on p.id = r.period_id
      join accounting_books b on b.id = r.book_id
     where r.id = ${runId} and r.org_id = ${context.authz.user.orgId}
     limit 1
  `)) as unknown as { rows: CloseRunRow[] };
  const row = result.rows[0];
  if (!row) throw notFound("close run");
  assertCloseSubsidiaries(context, row.scope?.subsidiaryIds ?? []);
  return row;
}

export async function listCloseRuns(
  context: ApplicationContext,
  input: { status?: string; limit?: number },
): Promise<CloseRunRow[]> {
  assertApplicationPermission(context, "close.run");
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  const result = (await db.execute(sql`
    select r.id, r.period_id as "periodId", p.name as "periodName",
           r.book_id as "bookId", b.code as "bookCode", r.status,
           r.current_stage as "currentStage", r.target_close_date as "targetCloseDate",
           r.scope, r.started_at as "startedAt", r.last_validated_at as "lastValidatedAt"
      from close_runs r
      join accounting_periods p on p.id = r.period_id
      join accounting_books b on b.id = r.book_id
     where r.org_id = ${context.authz.user.orgId}
       ${input.status ? sql`and r.status = ${input.status}` : sql``}
     order by p.ends_on desc, r.started_at desc
     limit ${limit}
  `)) as unknown as { rows: CloseRunRow[] };
  const allowed = context.authz.allowedSubsidiaryIds;
  return allowed === null
    ? result.rows
    : result.rows.filter((row) => {
      const subsidiaries = row.scope?.subsidiaryIds ?? [];
      return subsidiaries.length > 0 && subsidiaries.every((id) => allowed.has(id));
    });
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
  assertCloseSubsidiaries(context, input.subsidiaryIds ?? []);
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
  action: "refresh" | "request_approval" | "close" | "publish";
  comment?: string;
  idempotencyKey: string;
}): Promise<{ replayed: boolean; result: Record<string, unknown> }> {
  assertApplicationPermission(
    context,
    input.action === "close" ? "close.approve" : "close.run",
  );
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

export async function createReopenRequest(context: ApplicationContext, input: {
  periodId: string;
  bookId: string;
  subsidiaryId?: string;
  modules: CloseModule[];
  reason: string;
  idempotencyKey: string;
}): Promise<{ replayed: boolean; result: { requestId: string } }> {
  assertApplicationPermission(context, "close.reopen");
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
  const scope = (await db.execute(sql`
    select subsidiary_id as "subsidiaryId" from close_reopen_requests
     where id = ${input.requestId} and org_id = ${context.authz.user.orgId}
  `)) as unknown as { rows: { subsidiaryId: string | null }[] };
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

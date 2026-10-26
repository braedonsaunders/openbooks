import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { requestCloseApproval } from "@openbooks/engine/close/approvals";
import { closeApprovedRun, publishCloseRun } from "@openbooks/engine/close/run-completion";
import {
  CloseError,
  type CloseModule,
  type PeriodDisplayInput,
} from "@openbooks/engine/periods/period-policy";
import { submitPeriodReopen, requestPeriodReopen } from "@openbooks/engine/close/reopening";
import { refreshCloseRun } from "@openbooks/engine/close/run-automation";
import { startCloseRun } from "@openbooks/engine/close/run-start";
import {
  listRevaluationExposures,
  RevaluationError,
  RevaluationFeatureDisabledError,
  RevaluationScopeError,
  revaluationSubsidiarySelection,
  runRevaluation,
  type RevaluationExposureReadModel,
} from "@openbooks/engine/close/fx-revaluation";
import {
  ClosingFxEvidenceError,
  ClosingFxEvidenceFeatureDisabledError,
  recordClosingFxRateEvidence,
  type ClosingFxRateEvidenceRecord,
} from "@openbooks/engine/close/fx-revaluation-evidence";
import {
  readExactPeriodLocks,
  type ExactPeriodLockRead,
} from "@openbooks/engine/close/period-lock-read";
import { ScopeNotFoundError } from "@openbooks/engine/organization/scope";
import { can } from "../authz";
import type { ApplicationContext } from "./context";
import { assertApplicationPermission, assertSubsidiaryAccess } from "./context";
import { ApplicationError, forbidden, notFound } from "./errors";
import { isFeatureEnabled } from "../features";
import { clamp, isUuid } from "../list-params";
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
/**
 * The fiscal position and dates of an `accounting_periods` row aliased `p`,
 * returned beside its stored name so presenters label the period in the
 * viewer's locale (`periodDisplayLabel`) and every fiscal year reads alike.
 */
const PERIOD_REF_COLUMNS = sql`p.fiscal_year as period_fiscal_year, p.period_number as period_number,
             p.is_adjustment as period_is_adjustment,
             p.starts_on::text as period_starts_on, p.ends_on::text as period_ends_on`;

function periodRef(row: Record<string, unknown>): PeriodDisplayInput {
  return {
    fiscalYear: Number(row.period_fiscal_year),
    periodNumber: Number(row.period_number),
    adjustment: row.period_is_adjustment === true,
    startsOn: String(row.period_starts_on),
    endsOn: String(row.period_ends_on),
  };
}

type CloseRunRow = {
  id: string;
  periodId: string;
  /** The period's stored name. */
  periodName: string;
  /** The period's fiscal position and dates, for display labels. */
  periodRef: PeriodDisplayInput;
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
  const result = await db.execute<CloseRunDbRow>(
    sql`
    select r.id, r.period_id as "periodId", p.name as "periodName", ${PERIOD_REF_COLUMNS},
           r.book_id as "bookId", b.code as "bookCode", r.status,
           r.current_stage as "currentStage", r.target_close_date as "targetCloseDate",
           r.scope, r.started_at as "startedAt", r.last_validated_at as "lastValidatedAt"
      from close_runs r
      join accounting_periods p on p.id = r.period_id and p.org_id = r.org_id
      join accounting_books b on b.id = r.book_id and b.org_id = r.org_id
     where r.id = ${runId} and r.org_id = ${context.authz.user.orgId}
     limit 1
  `,
    "objects",
  );
  const row = result[0];
  if (!row) throw notFound("close run");
  return closeRunRow(row);
}

type CloseRunDbRow = Omit<CloseRunRow, "periodRef"> & {
  period_fiscal_year: number;
  period_number: number;
  period_is_adjustment: boolean;
  period_starts_on: string;
  period_ends_on: string;
};

function closeRunRow(row: CloseRunDbRow): CloseRunRow {
  const {
    period_fiscal_year,
    period_number,
    period_is_adjustment,
    period_starts_on,
    period_ends_on,
    ...run
  } = row;
  return {
    ...run,
    periodRef: periodRef({
      period_fiscal_year,
      period_number,
      period_is_adjustment,
      period_starts_on,
      period_ends_on,
    }),
  };
}

export async function listCloseRuns(
  context: ApplicationContext,
  input: { status?: string; limit?: number },
): Promise<CloseRunRow[]> {
  assertApplicationPermission(context, "close.run");
  // Declared lock targets do not narrow the organization-wide diagnostics.
  assertUnrestrictedCloseDiagnostics(context);
  const limit = clamp(input.limit ?? 50, 1, 100);
  const result = await db.execute<CloseRunDbRow>(
    sql`
    select r.id, r.period_id as "periodId", p.name as "periodName", ${PERIOD_REF_COLUMNS},
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
  `,
    "objects",
  );
  return result.map(closeRunRow);
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
    throw new ApplicationError(
      "invalid_input",
      "module must be ar, ap, banking, assets, tax, or gl",
      422,
    );
  }
  const limit = clamp(input.limit ?? 50, 1, 200);
  let where = sql`l.org_id = ${context.authz.user.orgId}`;
  if (input.periodId) where = sql`${where} and l.period_id = ${input.periodId}`;
  if (input.state) where = sql`${where} and l.state = ${input.state}`;
  if (input.module) where = sql`${where} and l.module = ${input.module}`;
  const [rows, count] = await Promise.all([
    db.execute<Record<string, unknown>>(
      sql`
      select l.id, l.module, l.state, l.locked_at, l.reason, l.reopen_expires_at,
             p.name as period_name, p.starts_on, p.ends_on, ${PERIOD_REF_COLUMNS},
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
    `,
      "objects",
    ),
    db.execute<{ n: string }>(
      sql`select count(*) as n from period_locks l where ${where}`,
      "objects",
    ),
  ]);
  return {
    total: Number(count[0]?.n ?? 0),
    locks: rows.map((lock) => ({
      id: lock.id,
      period: lock.period_name,
      periodRef: periodRef(lock),
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

/**
 * Exact effective lock state for one period/book/entity — the narrow
 * counterpart to the organization-wide `listPeriodLocks` diagnostics above.
 * A restricted caller authorized for exactly this entity may read it; the
 * engine re-resolves live `close.read` authority and entity scope inside
 * its read transaction. Scope and existence share the uniform not-found,
 * so another entity's or tenant's rows are never distinguishable.
 */
/** Canonical form of a validated application-boundary UUID, or a refusal. */
function canonicalApplicationUuid(value: string, field: string): string {
  if (!isUuid(value)) {
    throw new ApplicationError("invalid_input", `${field} must be a valid UUID`, 422);
  }
  return value.toLowerCase();
}

export async function readApplicationPeriodLocks(
  context: ApplicationContext,
  input: { periodId: string; bookId: string; subsidiaryId: string },
): Promise<ExactPeriodLockRead> {
  assertApplicationPermission(context, "close.read");
  // Canonicalize before the scope check: a granted entity named in upper
  // case is the same entity, while session scope sets carry canonical ids.
  const periodId = canonicalApplicationUuid(input.periodId, "periodId");
  const bookId = canonicalApplicationUuid(input.bookId, "bookId");
  const subsidiaryId = canonicalApplicationUuid(input.subsidiaryId, "subsidiaryId");
  assertSubsidiaryAccess(context, subsidiaryId);
  try {
    return await readExactPeriodLocks({
      orgId: context.authz.user.orgId,
      actorId: context.authz.user.id,
      periodId,
      bookId,
      subsidiaryId,
    });
  } catch (error) {
    if (error instanceof ScopeNotFoundError) throw notFound("period locks");
    if (error instanceof CloseError) {
      throw new ApplicationError("invalid_input", error.message, 422);
    }
    throw error;
  }
}

const REOPEN_STATUSES = new Set([
  "requested",
  "approved",
  "rejected",
  "withdrawn",
  "expired",
  "reclosed",
]);

/** Reopen requests — same query shape as `list_period_reopen_requests`. Org-wide diagnostics. */
export async function listPeriodReopenRequests(
  context: ApplicationContext,
  input: {
    status?: string;
    periodId?: string;
    requestId?: string;
    limit?: number;
    offset?: number;
  },
) {
  if (!can(context.authz, "close.reopen") && !can(context.authz, "periods.manage")) {
    throw forbidden("close.reopen");
  }
  assertUnrestrictedCloseDiagnostics(context);
  if (input.status && !REOPEN_STATUSES.has(input.status)) {
    throw new ApplicationError(
      "invalid_input",
      "status must be requested, approved, rejected, withdrawn, expired, or reclosed",
      422,
    );
  }
  const limit = clamp(input.limit ?? 50, 1, 100);
  const offset = clamp(input.offset ?? 0, 0, 1_000_000);
  let where = sql`r.org_id = ${context.authz.user.orgId}`;
  if (input.status) where = sql`${where} and r.status = ${input.status}`;
  if (input.periodId) where = sql`${where} and r.period_id = ${input.periodId}`;
  if (input.requestId)
    where = sql`${where} and r.id = ${canonicalApplicationUuid(input.requestId, "requestId")}`;
  const [rows, count] = await Promise.all([
    db.execute<Record<string, unknown>>(
      sql`
      select r.id, r.modules, r.reason, r.status, r.expires_at, r.reclosed_at, r.created_at, r.requested_by,
             r.approved_by,
             p.name as period_name, ${PERIOD_REF_COLUMNS}, b.name as book_name, b.code as book_code,
             s.name as subsidiary_name,
             req.name as requested_by_name, app.name as approved_by_name, r.approved_at,
             (select a.action from audit_log a
               where a.org_id = r.org_id and a.table_name = 'close_reopen_requests' and a.row_id = r.id
                 and a.action in ('approve', 'self_approve')
               order by a.at desc limit 1) as decision_action,
             (select a.changes#>>'{after,attestation}' from audit_log a
               where a.org_id = r.org_id and a.table_name = 'close_reopen_requests' and a.row_id = r.id
                 and a.action in ('approve', 'self_approve')
               order by a.at desc limit 1) as decision_attestation,
             (select ender.name from audit_log a
                left join users ender on ender.id = a.actor_id
               where a.org_id = r.org_id and a.table_name = 'close_reopen_requests' and a.row_id = r.id
                 and a.action = 'end'
               order by a.at desc limit 1) as end_actor_name,
             (select coalesce(a.changes#>>'{after,reason}', a.changes->>'reason') from audit_log a
               where a.org_id = r.org_id and a.table_name = 'close_reopen_requests' and a.row_id = r.id
                 and a.action = 'end'
               order by a.at desc limit 1) as end_reason
        from close_reopen_requests r
        join accounting_periods p on p.id = r.period_id and p.org_id = r.org_id
        join accounting_books b on b.id = r.book_id and b.org_id = r.org_id
        left join subsidiaries s on s.id = r.subsidiary_id and s.org_id = r.org_id
        left join users req on req.id = r.requested_by
        left join users app on app.id = r.approved_by
       where ${where}
       order by r.created_at desc
       limit ${limit} offset ${offset}
    `,
      "objects",
    ),
    db.execute<{ n: string }>(
      sql`select count(*) as n from close_reopen_requests r where ${where}`,
      "objects",
    ),
  ]);
  return {
    total: Number(count[0]?.n ?? 0),
    requests: rows.map((row) => ({
      id: row.id,
      period: row.period_name,
      periodRef: periodRef(row),
      book: row.book_name,
      bookCode: row.book_code,
      subsidiary: row.subsidiary_name,
      modules: row.modules,
      reason: row.reason,
      status: row.status,
      requestedBy: row.requested_by_name,
      requestedById: row.requested_by,
      approvedBy: row.approved_by_name,
      approvedById: row.approved_by,
      approvedAt: row.approved_at,
      decisionAction: row.decision_action,
      decisionAttestation: row.decision_attestation,
      endActorName: row.end_actor_name,
      endReason: row.end_reason,
      expiresAt: row.expires_at,
      reclosedAt: row.reclosed_at,
      createdAt: row.created_at,
    })),
  };
}

export async function getCloseRun(
  context: ApplicationContext,
  runId: string,
): Promise<CloseRunRow> {
  assertApplicationPermission(context, "close.run");
  return closeRun(context, runId);
}

export async function startApplicationCloseRun(
  context: ApplicationContext,
  input: {
    periodId: string;
    bookId: string;
    blueprintId?: string;
    reportingPackageId?: string;
    targetCloseDate?: string;
    subsidiaryIds?: string[];
    idempotencyKey: string;
  },
): Promise<{ replayed: boolean; result: { runId: string } }> {
  assertApplicationPermission(context, "close.run");
  assertSubsidiaryAccess(context, null);
  const outcome = await executeIdempotent({
    context,
    operation: "close.start",
    idempotencyKey: input.idempotencyKey,
    request: input,
    execute: async () => {
      try {
        return {
          runId: await startCloseRun({
            orgId: context.authz.user.orgId,
            actorId: context.authz.user.id,
            periodId: input.periodId,
            bookId: input.bookId,
            blueprintId: input.blueprintId,
            reportingPackageId: input.reportingPackageId,
            targetCloseDate: input.targetCloseDate,
            subsidiaryIds: input.subsidiaryIds,
          }),
        };
      } catch (error) {
        mapCloseError(error);
      }
    },
  });
  return { replayed: outcome.replayed, result: outcome.value };
}

export async function advanceCloseRun(
  context: ApplicationContext,
  input: {
    runId: string;
    action: "refresh" | "request_approval" | "close" | "publish";
    comment?: string;
    idempotencyKey: string;
  },
): Promise<{ replayed: boolean; result: Record<string, unknown> }> {
  assertApplicationPermission(context, input.action === "close" ? "close.approve" : "close.run");
  if (
    input.action === "publish" &&
    !(await isFeatureEnabled(context.authz.user.orgId, "advancedClose"))
  ) {
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
          return {
            refreshed: true,
            ...(await refreshCloseRun(
              context.authz.user.orgId,
              input.runId,
              context.authz.user.id,
            )),
          };
        }
        if (input.action === "request_approval") {
          await requestCloseApproval(context.authz.user.orgId, input.runId, context.authz.user.id);
        } else if (input.action === "close") {
          await closeApprovedRun(context.authz.user.orgId, input.runId, context.authz.user.id);
        } else {
          await publishCloseRun(
            context.authz.user.orgId,
            input.runId,
            context.authz.user.id,
            input.comment,
          );
        }
        return { action: input.action, run: await closeRun(context, input.runId) };
      } catch (error) {
        mapCloseError(error);
      }
    },
  });
  return { replayed: outcome.replayed, result: outcome.value };
}

export async function runPeriodRevaluation(
  context: ApplicationContext,
  input: {
    periodId: string;
    bookId?: string;
    subsidiaryIds?: string[];
    idempotencyKey: string;
  },
): Promise<{ replayed: boolean; result: Record<string, unknown> }> {
  assertApplicationPermission(context, "close.run");
  let selected: string[] | undefined;
  try {
    selected = revaluationSubsidiarySelection(
      context.authz.allowedSubsidiaryIds,
      input.subsidiaryIds,
    );
  } catch (error) {
    if (error instanceof RevaluationScopeError)
      throw new ApplicationError(
        error.status === 403 ? "forbidden" : "invalid_input",
        error.message,
        error.status,
      );
    throw error;
  }
  const outcome = await executeIdempotent({
    context,
    operation: "close.revaluation.run",
    idempotencyKey: input.idempotencyKey,
    request: {
      periodId: input.periodId,
      bookId: input.bookId ?? null,
      subsidiaryIds: selected ?? null,
    },
    execute: async (): Promise<Record<string, unknown>> => {
      try {
        const run = await runRevaluation(
          context.authz.user.orgId,
          input.periodId,
          context.authz.user.id,
          selected,
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

/**
 * The selected-entity exposure read model for recorded closing rates: the
 * revaluation engine's own positions for one book and period, restricted to
 * the caller's legal-entity scope. An empty restricted scope reads as an
 * empty list, never as organization-wide evidence.
 */
export async function listApplicationRevaluationExposures(
  context: ApplicationContext,
  input: { periodId: string; bookId: string; subsidiaryIds?: string[] },
): Promise<RevaluationExposureReadModel[]> {
  assertApplicationPermission(context, "close.run");
  const allowed = context.authz.allowedSubsidiaryIds;
  const selected = input.subsidiaryIds ?? (allowed === null ? undefined : [...allowed]);
  if (selected) {
    for (const subsidiaryId of selected) assertSubsidiaryAccess(context, subsidiaryId);
  }
  return listRevaluationExposures(context.authz.user.orgId, input.bookId, input.periodId, selected);
}

/**
 * Record one closing rate for an exact exposure position. The caller's
 * idempotency key is the recording's single replay identity: it becomes the
 * engine request id, so the ordinary and public transports cannot carry two
 * conflicting keys for one recording.
 */
export async function recordApplicationClosingFxRateEvidence(
  context: ApplicationContext,
  input: {
    bookId: string;
    subsidiaryId: string;
    periodId: string;
    accountId: string;
    transactionCurrency: string;
    measurementCurrency: string;
    rateDate?: string;
    rate: string;
    source: string;
    reason: string;
    expectedCurrentId: string | null;
    idempotencyKey: string;
  },
): Promise<{ replayed: boolean; result: ClosingFxRateEvidenceRecord }> {
  assertApplicationPermission(context, "close.run");
  assertSubsidiaryAccess(context, input.subsidiaryId);
  if (!isUuid(input.idempotencyKey)) {
    throw new ApplicationError(
      "invalid_input",
      "Idempotency-Key must be a UUID — it becomes the recorded closing rate's request identity",
      400,
    );
  }
  try {
    const outcome = await recordClosingFxRateEvidence({
      orgId: context.authz.user.orgId,
      actorId: context.authz.user.id,
      input: { ...input, requestId: input.idempotencyKey },
    });
    return { replayed: outcome.replayed, result: outcome.evidence };
  } catch (error) {
    if (error instanceof ClosingFxEvidenceFeatureDisabledError)
      throw notFound("closing rate evidence");
    if (error instanceof ScopeNotFoundError) throw notFound("closing rate evidence");
    if (error instanceof ClosingFxEvidenceError) {
      throw new ApplicationError("invalid_input", error.message, 422);
    }
    throw error;
  }
}

export async function createReopenRequest(
  context: ApplicationContext,
  input: {
    periodId: string;
    bookId: string;
    subsidiaryId?: string;
    modules: CloseModule[];
    reason: string;
    hours?: number;
    idempotencyKey: string;
  },
): Promise<{ replayed: boolean; result: { requestId: string } }> {
  assertApplicationPermission(context, "close.reopen");
  assertSubsidiaryAccess(context, null);
  assertSubsidiaryAccess(context, input.subsidiaryId);
  const outcome = await executeIdempotent({
    context,
    operation: "close.reopen.request",
    idempotencyKey: input.idempotencyKey,
    request: input,
    execute: async () => {
      try {
        return {
          requestId: await requestPeriodReopen({
            orgId: context.authz.user.orgId,
            actorId: context.authz.user.id,
            periodId: input.periodId,
            bookId: input.bookId,
            subsidiaryId: input.subsidiaryId,
            modules: input.modules,
            reason: input.reason,
            hours: input.hours,
          }),
        };
      } catch (error) {
        mapCloseError(error);
      }
    },
  });
  return { replayed: outcome.replayed, result: outcome.value };
}

export async function submitReopenRequest(
  context: ApplicationContext,
  input: { requestId: string; hours?: number; idempotencyKey: string },
): Promise<{
  replayed: boolean;
  result: { requestId: string; gated: boolean };
}> {
  assertApplicationPermission(context, "close.reopen");
  const scope = (
    await db.execute<{ subsidiaryId: string | null }>(
      sql`select subsidiary_id as "subsidiaryId" from close_reopen_requests where org_id=${context.authz.user.orgId} and id=${input.requestId}`,
      "objects",
    )
  )[0];
  if (!scope) throw notFound("reopen request");
  assertSubsidiaryAccess(context, scope.subsidiaryId);
  const outcome = await executeIdempotent({
    context,
    operation: "close.reopen.submit",
    idempotencyKey: input.idempotencyKey,
    request: input,
    execute: async () => {
      try {
        const result = await submitPeriodReopen({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          requestId: input.requestId,
          hours: input.hours,
        });
        return { requestId: input.requestId, gated: result.gated };
      } catch (error) {
        mapCloseError(error);
      }
    },
  });
  return { replayed: outcome.replayed, result: outcome.value };
}

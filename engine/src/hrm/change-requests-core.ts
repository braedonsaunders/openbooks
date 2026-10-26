import { sql } from "drizzle-orm";
import { HRM_CHANGE_REQUEST_SUBJECT_KIND } from "@openbooks/schema/src/hrm-change-requests.ts";
import { type SqlExecutor } from "../platform/db.ts";
import {
  HrmAuthorizationError,
  requireHrmEmploymentManage,
  requireHrmEmploymentRead,
  requireOwnEmploymentSubject,
} from "./authorization.ts";
import { intervalsOverlap, parseCivilDate } from "./temporal.ts";
import { inputGuards } from "./input-guards.ts";
import { businessTodayInTx } from "../platform/business-date.ts";
import { takeEmployeeConfigurationFence } from "../payroll/fences.ts";
import { assertEmploymentHireWorker } from "./employment-worker.ts";
import {
  HrmChangeRequestError,
  type StatusChangePayload,
  type ChangeRequestPayload,
  validateChangePayload,
} from "./change-requests-payload.ts";

export type RequestRow = {
  id: string;
  org_id: string;
  employment_id: string;
  request_revision: number;
  expected_employment_revision: number;
  payload: unknown;
  payload_digest: string;
  payload_schema_version: string;
  reason: string | null;
  /** Generic HR action (0227). Null = unclassified. */
  action: string | null;
  /** Reason code from hrm_action_reasons (0227). */
  reason_code: string | null;
  status: string;
  submitted_by: string | null;
  submitted_at: Date | string | null;
  flow_run_id: string | null;
  decision_snapshot: Record<string, unknown> | null;
  applied_at: Date | string | null;
  applied_by: string | null;
  applied_employment_revision: number | null;
  applied_employment_change_id: string | null;
  created_at: Date | string;
  created_by: string | null;
  updated_at: Date | string;
  updated_by: string | null;
};

export interface ChangeRequestDTO {
  readonly id: string;
  readonly orgId: string;
  readonly employmentId: string;
  readonly requestRevision: number;
  readonly expectedEmploymentRevision: number;
  readonly payload: ChangeRequestPayload;
  readonly payloadDigest: string;
  readonly payloadSchemaVersion: string;
  readonly reason: string | null;
  /** Generic HR action (0227). */
  readonly action: string | null;
  /** Reason code (0227). */
  readonly reasonCode: string | null;
  readonly status: string;
  readonly submittedBy: string | null;
  readonly submittedAt: Date | null;
  readonly flowRunId: string | null;
  readonly decisionSnapshot: Record<string, unknown> | null;
  readonly appliedAt: Date | null;
  readonly appliedBy: string | null;
  readonly appliedEmploymentRevision: number | null;
  readonly appliedEmploymentChangeId: string | null;
  readonly createdAt: Date;
  readonly createdBy: string | null;
  readonly updatedAt: Date;
  readonly updatedBy: string | null;
}

/**
 * One timestamp shape at the DB boundary. A row can reach toDTO with its
 * timestamptz columns as Date (the pg type parser) or as ISO text (rows
 * read back through paths that serialize, e.g. a RETURNING re-read or a
 * JSON hop), and the queue then crashed calling toISOString on a string.
 * Normalize once here so every DTO carries a real Date; a value that is
 * neither refuses by name instead of rendering "Invalid Date".
 */
function asTimestamp(value: Date | string, column: string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`change request ${column} is not a valid timestamp: ${String(value)}`);
  }
  return date;
}

function asOptionalTimestamp(value: Date | string | null, column: string): Date | null {
  return value === null || value === undefined ? null : asTimestamp(value, column);
}

export function toDTO(row: RequestRow): ChangeRequestDTO {
  return {
    id: row.id,
    orgId: row.org_id,
    employmentId: row.employment_id,
    requestRevision: row.request_revision,
    expectedEmploymentRevision: row.expected_employment_revision,
    payload: validateChangePayload(row.payload),
    payloadDigest: row.payload_digest,
    payloadSchemaVersion: row.payload_schema_version,
    reason: row.reason,
    action: row.action ?? null,
    reasonCode: row.reason_code ?? null,
    status: row.status,
    submittedBy: row.submitted_by,
    submittedAt: asOptionalTimestamp(row.submitted_at, "submitted_at"),
    flowRunId: row.flow_run_id,
    decisionSnapshot: row.decision_snapshot,
    appliedAt: asOptionalTimestamp(row.applied_at, "applied_at"),
    appliedBy: row.applied_by,
    appliedEmploymentRevision: row.applied_employment_revision,
    appliedEmploymentChangeId: row.applied_employment_change_id,
    createdAt: asTimestamp(row.created_at, "created_at"),
    createdBy: row.created_by,
    updatedAt: asTimestamp(row.updated_at, "updated_at"),
    updatedBy: row.updated_by,
  };
}

export const REQUEST_COLUMNS = sql`
  id, org_id, employment_id, request_revision, expected_employment_revision,
  payload, payload_digest, payload_schema_version, reason, action, reason_code, status,
  submitted_by, submitted_at, flow_run_id, decision_snapshot,
  applied_at, applied_by, applied_employment_revision, applied_employment_change_id,
  created_at, created_by, updated_at, updated_by
`;

export const { requireOrgId, requireActorId, requireId } = inputGuards(
  (message) => new HrmChangeRequestError("REFUSED", message),
);

export function requireReason(reason: unknown): string {
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new HrmChangeRequestError(
      "INVALID_PAYLOAD",
      "submission carries a non-blank reason — record why the change is proposed",
    );
  }
  return reason.trim();
}

export async function loadRequestForUpdate(
  exec: SqlExecutor,
  orgId: string,
  requestId: string,
): Promise<RequestRow> {
  const rows = await exec.execute<RequestRow>(
    sql`
    select ${REQUEST_COLUMNS} from hrm_employment_change_requests
     where org_id = ${orgId} and id = ${requestId} for update
  `,
    "objects",
  );
  const row = rows[0];
  // Zero rows is a failure: unknown id, or an id from another organization
  // (the org_id predicate is the org-isolation enforcement — never report
  // which of the two, so existence cannot be probed across tenants).
  if (!row) {
    throw new HrmChangeRequestError(
      "NOT_FOUND",
      "employment change request not found in this organization — check the request id",
    );
  }
  return row;
}

// --- Kind preconditions (fail fast at authoring and at submit) ---------------

export type LiveEmploymentVersion = {
  id: string;
  version_no: number;
  status: string;
  effective_from: string;
  effective_to: string | null;
  before: unknown;
};

export async function liveEmploymentVersions(
  exec: SqlExecutor,
  orgId: string,
  employmentId: string,
): Promise<LiveEmploymentVersion[]> {
  const rows = await exec.execute<{
    id: string;
    version_no: number;
    status: string;
    effective_from: string;
    effective_to: string | null;
    before: unknown;
  }>(
    sql`
    select id, version_no, status,
           effective_from::text as effective_from,
           effective_to::text as effective_to,
           to_jsonb(worker_employment_versions) as before
      from worker_employment_versions
     where org_id = ${orgId} and employment_id = ${employmentId}
       and recorded_until is null
     order by version_no
  `,
    "objects",
  );
  return rows;
}

export async function employmentVersionCount(
  exec: SqlExecutor,
  orgId: string,
  employmentId: string,
): Promise<number> {
  const rows = await exec.execute<{ n: number }>(
    sql`
    select count(*)::int as n from worker_employment_versions
     where org_id = ${orgId} and employment_id = ${employmentId}
  `,
    "objects",
  );
  return rows[0]?.n ?? 0;
}

/**
 * Kind-aware authoring gate. Employment kinds ride hrm.employment.manage;
 * the self-service profile_change and bank_change kinds ride
 * hrm.self.request plus proof the bound employment is the actor's own
 * (the own-employment subject gate) — an HR manage grant never files a
 * self-service change, and a self grant never authors an employment
 * change. Returns the trusted subject for revision binding either way.
 */
export async function requireAuthoringAccess(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  employmentId: string,
  payload: ChangeRequestPayload,
) {
  if (payload.kind === "profile_change" || payload.kind === "bank_change") {
    return requireOwnEmploymentSubject(exec, orgId, actorId, employmentId, "hrm.self.request");
  }
  return requireHrmEmploymentManage(exec, orgId, actorId, employmentId);
}

/**
 * Kind-aware read gate for one stored request row. The employment read
 * gate is tried first, so HR keeps full queue visibility over every kind
 * including the self-service ones; only when it denies AND the row is a
 * profile_change or bank_change does the own-employment self.read gate
 * get its turn — the person watches their own proposal travel the
 * approval. A stranger keeps the employment-gate refusal, never the
 * self-service one.
 */
export async function requireRequestReadAccess(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  employmentId: string,
  payload: unknown,
): Promise<void> {
  try {
    await requireHrmEmploymentRead(exec, orgId, actorId, employmentId);
    return;
  } catch (error) {
    const kind =
      typeof payload === "object" && payload !== null
        ? (payload as { kind?: unknown }).kind
        : undefined;
    if (
      !(error instanceof HrmAuthorizationError) ||
      (kind !== "profile_change" && kind !== "bank_change")
    ) {
      throw error;
    }
    await requireOwnEmploymentSubject(exec, orgId, actorId, employmentId, "hrm.self.read");
  }
}

/**
 * Authoring-time preconditions per kind, re-checked at submit: a hire lands
 * only on a version-less (reserved) identity; every other kind needs an
 * existing effective version; a termination needs a non-terminated live
 * version; a profile change binds the live revision of an employment that
 * already has one (its worker party is the edited party). These are request-state checks — the apply re-derives everything
 * under the aggregate lock and refuses stale races there.
 */
export async function assertKindPreconditions(
  exec: SqlExecutor,
  orgId: string,
  employmentId: string,
  payload: ChangeRequestPayload,
): Promise<void> {
  if (payload.kind === "hire") {
    await assertEmploymentHireWorker(exec, orgId, employmentId);
    const count = await employmentVersionCount(exec, orgId, employmentId);
    if (count > 0) {
      throw new HrmChangeRequestError(
        "BAD_STATE",
        "this employment already has an effective version — file a status change, not a hire",
      );
    }
    if (payload.initialAssignment?.positionId) {
      const position = (
        await exec.execute(
          sql`
        select 1 as one from positions where org_id = ${orgId} and id = ${payload.initialAssignment!.positionId}
      `,
          "objects",
        )
      )[0];
      if (!position) {
        throw new HrmChangeRequestError(
          "INVALID_PAYLOAD",
          "the position is not visible in this organization — name a position of this organization",
        );
      }
    }
    return;
  }
  const live = await liveEmploymentVersions(exec, orgId, employmentId);
  if (live.length === 0) {
    throw new HrmChangeRequestError(
      "BAD_STATE",
      "this employment has no effective version yet — file a hire before changing it",
    );
  }
  if (payload.kind === "status_change" && payload.historicalObservation) {
    await assertHistoricalStatusWindow(exec, orgId, employmentId, payload);
  }
  // A termination is a duplicate only where it lands: the window it
  // closes must already be fully terminated. History outside the window
  // is preserved, never rewritten — a retained active slice beside a
  // terminated one does not make a later termination a duplicate.
  if (payload.kind === "termination") {
    const overlapping = live.filter((version) =>
      effectiveOverlaps(version, payload.effectiveDate, null),
    );
    if (overlapping.length > 0 && overlapping.every((version) => version.status === "terminated")) {
      throw new HrmChangeRequestError(
        "BAD_STATE",
        "this employment is already terminated — a second termination is a duplicate, not an update",
      );
    }
  }
  if (payload.kind === "position_assignment" && payload.positionId !== null) {
    const position = (
      await exec.execute(
        sql`
      select 1 as one from positions where org_id = ${orgId} and id = ${payload.positionId}
    `,
        "objects",
      )
    )[0];
    if (!position) {
      throw new HrmChangeRequestError(
        "INVALID_PAYLOAD",
        "the position is not visible in this organization — name a position of this organization",
      );
    }
  }
}

// --- Decision snapshot shared by direct apply and approval release ---------

export type DecidedGate = {
  gate_id: string;
  decision: string;
  decided_by: string | null;
  on_behalf_of_user_id: string | null;
  decided_at: Date | null;
  comment: string | null;
};

export async function decidedGatesOfRequest(
  exec: SqlExecutor,
  orgId: string,
  requestId: string,
): Promise<DecidedGate[]> {
  const rows = await exec.execute<DecidedGate>(
    sql`
    select id as gate_id, status as decision, decided_by, on_behalf_of_user_id,
           decided_at, comment
      from flow_gates
     where org_id = ${orgId} and subject_kind = ${HRM_CHANGE_REQUEST_SUBJECT_KIND} and subject_id = ${requestId}
       and status in ('approved', 'rejected')
     order by decided_at, id
  `,
    "objects",
  );
  return rows;
}

export function buildDecisionSnapshot(args: {
  request: RequestRow;
  outcome: "approved" | "rejected";
  gates: readonly DecidedGate[];
}): Record<string, unknown> {
  return {
    outcome: args.outcome,
    payload_digest: args.request.payload_digest,
    payload_schema_version: args.request.payload_schema_version,
    expected_employment_revision: args.request.expected_employment_revision,
    flow_run_id: args.request.flow_run_id,
    gates: args.gates.map((gate) => ({
      gate_id: gate.gate_id,
      decision: gate.decision,
      decided_by: gate.decided_by,
      on_behalf_of_user_id: gate.on_behalf_of_user_id,
      decided_at: gate.decided_at instanceof Date ? gate.decided_at.toISOString() : gate.decided_at,
      comment: gate.comment,
    })),
  };
}
export type ClosureElement = {
  table: string;
  identity: string;
  version_no: number;
  row_id: string;
  before: unknown;
};

export type AssignmentSlotVersion = {
  id: string;
  version_no: number;
  position_id: string | null;
  job_title: string | null;
  department_id: string | null;
  location_id: string | null;
  fte: string;
  is_primary: boolean;
  effective_from: string;
  effective_to: string | null;
  before: unknown;
};

/** Overlap on the half-open effective grid (temporal.ts owns the semantics). */
export function effectiveOverlaps(
  row: { effective_from: string; effective_to: string | null },
  start: string,
  end: string | null,
): boolean {
  return intervalsOverlap(
    {
      start: parseCivilDate(row.effective_from),
      end: row.effective_to === null ? null : parseCivilDate(row.effective_to),
    },
    { start: parseCivilDate(start), end: end === null ? null : parseCivilDate(end) },
  );
}
export async function assertEmploymentStatusPayrollWindow(
  exec: SqlExecutor,
  orgId: string,
  employmentId: string,
  from: string,
  end: string | null,
): Promise<void> {
  const subject = (
    await exec.execute<{ worker_party_id: string; employer_subsidiary_id: string }>(
      sql`
    select worker_party_id,employer_subsidiary_id from worker_employments where org_id=${orgId} and id=${employmentId}
  `,
      "objects",
    )
  )[0];
  if (!subject)
    throw new HrmChangeRequestError("NOT_FOUND", "Select a saved employment in this organization.");
  // Payroll calculation and commit take this employee-wide fence before
  // their year locks, so a committed-period check cannot race a commit.
  await takeEmployeeConfigurationFence(exec, orgId, subject.worker_party_id);
  const committed = (
    await exec.execute<{ pay_date: string }>(
      sql`
    select r.pay_date::text from pay_runs r
    join pay_stubs s on s.org_id=r.org_id and s.pay_run_document_id=r.document_id
    join documents d on d.org_id=r.org_id and d.id=r.document_id
    where r.org_id=${orgId} and s.employee_party_id=${subject.worker_party_id}
      and (s.employment_id=${employmentId} or (s.employment_id is null
        and (d.subsidiary_id=${subject.employer_subsidiary_id} or d.subsidiary_id is null)))
      and r.run_status='committed'  and d.status<>'voided'
      and (((${end}::date is null or r.period_start<${end}::date) and r.period_end>=${from}::date)
        or (r.pay_date>=${from}::date and (${end}::date is null or r.pay_date<${end}::date)))
    limit 1
  `,
      "objects",
    )
  )[0];
  if (committed) {
    throw new HrmChangeRequestError(
      "REFUSED",
      `Payroll dated ${committed.pay_date} is committed for this employment window; preserve its status evidence and use a governed correction.`,
    );
  }
}

/** Historical observations fill only documented gaps; they never supersede a status. */
export async function assertHistoricalStatusWindow(
  exec: SqlExecutor,
  orgId: string,
  employmentId: string,
  payload: StatusChangePayload,
): Promise<void> {
  const end = payload.effectiveTo;
  if (
    !payload.historicalObservation ||
    end === null ||
    end > (await businessTodayInTx(exec, orgId))
  ) {
    throw new HrmChangeRequestError(
      "REFUSED",
      "Record a bounded historical status window ending before the current business day; use an ordinary status change for current employment.",
    );
  }
  await assertEmploymentStatusPayrollWindow(exec, orgId, employmentId, payload.effectiveFrom, end);
  const live = await liveEmploymentVersions(exec, orgId, employmentId);
  if (
    !live.length ||
    live.some((version) => effectiveOverlaps(version, payload.effectiveFrom, end))
  ) {
    throw new HrmChangeRequestError(
      "REFUSED",
      "A historical observation must fill an uncovered employment window; review the existing status history without overwriting it.",
    );
  }
}

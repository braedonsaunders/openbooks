/**
 * Canonical as-of employment READ service (no mutations).
 *
 * Reads the 0184 HRM employment foundation (schema custodian contract):
 * worker_employments (stable) + worker_employment_versions (bitemporal) +
 * employment_assignments (stable slots) + employment_assignment_versions
 * (bitemporal). Reporting relationships and employment_changes are out of
 * scope for this DTO.
 *
 * Resolution delegates to temporal.ts: recorded filter
 * (recordedAt <= asKnown < recordedUntil) first, then effective membership;
 * zero applicable revisions is a refusal, more than one is a refusal. Never
 * resolves through JS Date: civil dates cross as YYYY-MM-DD text and recorded
 * stamps cross as exact UTC text projected in SQL with microsecond precision.
 *
 * Boundary: getEmploymentAsOf owns withOrgTransaction plus the authoritative
 * HRM feature gate (key `hrm`, registered in the coherent integration; the
 * gate fails closed until then). Authorization is injected as
 * AuthorizeEmploymentRead, whose contract matches the auth owner's
 * requireHrmEmploymentRead(exec, orgId, actorId, employmentId): it returns a
 * branded trusted subject and this module reuses that record in-transaction,
 * never re-reading or re-deriving the subject.
 */

import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../db.ts";
import { lockAndCheckOrgFeature } from "../org-feature-lock.ts";
import {
  requireHrmEmploymentRead,
  type TrustedEmploymentSubject,
} from "./authorization.ts";
import {
  containsDate,
  NoRevisionError,
  parseCivilDate,
  resolveAsOf,
  AmbiguousRevisionError,
  type RecordedRevision,
} from "./temporal.ts";

export class EmploymentReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmploymentReadError";
  }
}

/** Feature key for the HRM domain; registered in the coherent integration. */
export const HRM_FEATURE_KEY = "hrm" as const;

/** UTC instant wire format shared with temporal.ts recorded stamps. */
const RECORDED_TEXT =
  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"' as const;

export interface EmploymentAsOfQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly employmentId: string;
  /** Civil effective date (YYYY-MM-DD). */
  readonly effectiveDate: string;
  /** As-known UTC instant (YYYY-MM-DDTHH:mm:ss[.fraction]Z). */
  readonly knownAt: string;
}

/**
 * Authorization is the auth owner's requireHrmEmploymentRead
 * (engine/src/hrm/authorization.ts): exact hrm.employment.read grant plus
 * employer-subsidiary scope, returned as a branded TrustedEmploymentSubject
 * that only its loader can produce. This module reuses that record
 * in-transaction and never re-reads or re-derives the subject.
 */
export type AuthorizeEmploymentRead = (
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  employmentId: string,
) => Promise<TrustedEmploymentSubject>;

/** One stable employment row (worker_employments). Minimal: no status, no dates. */
export interface EmploymentStableRow {
  readonly id: string;
  readonly orgId: string;
  readonly workerPartyId: string;
  readonly employerSubsidiaryId: string;
  readonly revision: number;
}

/** One employment version row, stamps already projected to exact text. */
export interface EmploymentVersionRow {
  readonly versionNo: number;
  readonly status: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly recordedAt: string;
  readonly recordedUntil: string | null;
}

/** One stable assignment slot (employment_assignments). */
export interface AssignmentSlotRow {
  readonly id: string;
  readonly assignmentKey: string;
}

/** One assignment version row, stamps already projected to exact text. */
export interface AssignmentVersionRow {
  readonly versionNo: number;
  readonly jobTitle: string | null;
  readonly departmentId: string | null;
  readonly locationId: string | null;
  /** Exact numeric text (fte::text); never converted through Number. */
  readonly fte: string;
  readonly isPrimary: boolean;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly recordedAt: string;
  readonly recordedUntil: string | null;
}

export interface EmploymentVersionDTO {
  readonly versionNo: number;
  readonly status: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly recordedAt: string;
  readonly recordedUntil: string | null;
}

export interface AssignmentDTO {
  readonly assignmentId: string;
  readonly assignmentKey: string;
  readonly versionNo: number;
  readonly jobTitle: string | null;
  readonly departmentId: string | null;
  readonly locationId: string | null;
  /** Exact decimal string as stored; no floating-point handling. */
  readonly fte: string;
  readonly isPrimary: boolean;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly recordedAt: string;
  readonly recordedUntil: string | null;
}

export interface EmploymentDTO {
  readonly employmentId: string;
  readonly orgId: string;
  readonly workerPartyId: string;
  readonly employerSubsidiaryId: string;
  readonly revision: number;
  readonly version: EmploymentVersionDTO;
  /** Slots applicable at the as-of point; empty is legitimate (no refusal). */
  readonly assignments: readonly AssignmentDTO[];
}

function requireId(field: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new EmploymentReadError(`${field} must be a non-empty string`);
  }
  return value;
}

/**
 * Validate the as-of inputs with the real temporal parsers before any read,
 * so a malformed knownAt fails as INVALID_RECORDED_STAMP even when the
 * employment has no versions (which would otherwise report NO_REVISION).
 * resolveAsOf parses its query first, so probing it against an empty chain
 * validates without resolving; the expected NoRevisionError is swallowed.
 */
function validateAsOf(effectiveDate: string, knownAt: string): void {
  const effective = parseCivilDate(effectiveDate);
  try {
    resolveAsOf([], { effective, asKnown: knownAt });
  } catch (error) {
    if (error instanceof NoRevisionError) return;
    throw error;
  }
}

function toEmploymentRevisions(
  rows: readonly EmploymentVersionRow[],
): RecordedRevision<{ versionNo: number; status: string }>[] {
  return rows.map((row) => ({
    effective: { start: parseCivilDate(row.effectiveFrom), end: row.effectiveTo === null ? null : parseCivilDate(row.effectiveTo) },
    recordedAt: row.recordedAt,
    recordedUntil: row.recordedUntil,
    payload: { versionNo: row.versionNo, status: row.status },
  }));
}

function toAssignmentRevisions(
  rows: readonly AssignmentVersionRow[],
): RecordedRevision<AssignmentVersionRow>[] {
  return rows.map((row) => ({
    effective: { start: parseCivilDate(row.effectiveFrom), end: row.effectiveTo === null ? null : parseCivilDate(row.effectiveTo) },
    recordedAt: row.recordedAt,
    recordedUntil: row.recordedUntil,
    payload: row,
  }));
}

/**
 * Pure assembly: resolve one employment version plus every applicable
 * assignment slot at (effectiveDate, knownAt). Simultaneous assignments are
 * all returned; at most one may be primary. A slot with no version covering
 * the effective date did not hold then and is excluded (legitimate absence),
 * while a slot whose effective-covering versions leave no live revision at
 * knownAt is an inconsistent chain and is refused. Throws EmploymentReadError
 * for missing employment/grant mismatch; temporal refusals propagate.
 */
export function assembleEmploymentAsOf(
  stable: EmploymentStableRow | null,
  employmentVersions: readonly EmploymentVersionRow[],
  slots: readonly { slot: AssignmentSlotRow; versions: readonly AssignmentVersionRow[] }[],
  query: Pick<EmploymentAsOfQuery, "effectiveDate" | "knownAt">,
): EmploymentDTO {
  validateAsOf(query.effectiveDate, query.knownAt);
  if (stable === null) {
    throw new EmploymentReadError(
      `employment not found: no worker_employments row for the requested id; check the employment id`,
    );
  }
  const resolved = resolveAsOf(toEmploymentRevisions(employmentVersions), {
    effective: query.effectiveDate,
    asKnown: query.knownAt,
  });
  const assignments: AssignmentDTO[] = [];
  for (const { slot, versions } of slots) {
    const revisions = toAssignmentRevisions(versions);
    const coversEffective = revisions.filter((revision) =>
      containsDate(revision.effective, query.effectiveDate),
    );
    // Slot held nothing on the effective date: legitimate absence, not a gap.
    if (coversEffective.length === 0) continue;
    const live = resolveAsOf(revisions, {
      effective: query.effectiveDate,
      asKnown: query.knownAt,
    });
    const row = live.payload;
    if (typeof row.fte !== "string" || row.fte.length === 0) {
      throw new EmploymentReadError(
        `assignment ${slot.id} version ${row.versionNo} has no precise fte text; re-read the row as fte::text`,
      );
    }
    assignments.push({
      assignmentId: slot.id,
      assignmentKey: slot.assignmentKey,
      versionNo: row.versionNo,
      jobTitle: row.jobTitle,
      departmentId: row.departmentId,
      locationId: row.locationId,
      fte: row.fte,
      isPrimary: row.isPrimary,
      effectiveFrom: live.effective.start,
      effectiveTo: live.effective.end,
      recordedAt: live.recordedAt,
      recordedUntil: live.recordedUntil,
    });
  }
  assignments.sort((a, b) => (a.assignmentKey < b.assignmentKey ? -1 : a.assignmentKey > b.assignmentKey ? 1 : 0));
  const primaries = assignments.filter((assignment) => assignment.isPrimary);
  if (primaries.length > 1) {
    throw new AmbiguousRevisionError(
      `${primaries.length} primary assignments cover ${query.effectiveDate} as known at ${query.knownAt} (${primaries.map((assignment) => assignment.assignmentKey).join("; ")}); at most one assignment may be primary at one as-of point`,
    );
  }
  return {
    employmentId: stable.id,
    orgId: stable.orgId,
    workerPartyId: stable.workerPartyId,
    employerSubsidiaryId: stable.employerSubsidiaryId,
    revision: stable.revision,
    version: {
      versionNo: resolved.payload.versionNo,
      status: resolved.payload.status,
      effectiveFrom: resolved.effective.start,
      effectiveTo: resolved.effective.end,
      recordedAt: resolved.recordedAt,
      recordedUntil: resolved.recordedUntil,
    },
    assignments,
  };
}

interface EmploymentVersionRowRaw {
  version_no: number;
  status: string;
  effective_from: string;
  effective_to: string | null;
  recorded_at: string;
  recorded_until: string | null;
}

interface AssignmentSlotRowRaw {
  id: string;
  assignment_key: string;
}

interface AssignmentVersionRowRaw {
  version_no: number;
  job_title: string | null;
  department_id: string | null;
  location_id: string | null;
  fte: string;
  is_primary: boolean;
  effective_from: string;
  effective_to: string | null;
  recorded_at: string;
  recorded_until: string | null;
}

/**
 * Load and assemble inside the caller's transaction (RLS applies). No
 * arbitrary SQL identifiers: every value is a bound parameter and every
 * column list is explicit. Recorded stamps are projected with microsecond
 * to_char in SQL so sub-millisecond precision never passes through JS Date.
 *
 * Gate-free by design: only getEmploymentAsOf enforces the HRM feature key.
 * A future internal payroll canonical resolver must reuse this loader (or
 * the pure assembler below) with its own authority, never the gated entry:
 * payroll stays independently usable while HRM is off, and no payroll
 * dependency may be read into the shared pure resolution.
 */
export async function loadEmploymentAsOf(
  exec: SqlExecutor,
  query: EmploymentAsOfQuery,
  authorize: AuthorizeEmploymentRead = requireHrmEmploymentRead,
): Promise<EmploymentDTO> {
  const orgId = requireId("orgId", query.orgId);
  const actorId = requireId("actorId", query.actorId);
  const employmentId = requireId("employmentId", query.employmentId);
  validateAsOf(query.effectiveDate, query.knownAt);

  // The trusted subject IS the stable row: reuse it in-transaction, never
  // re-read worker_employments here. Missing/wrong-org/out-of-scope subjects
  // are refused inside the gate (HrmAuthorizationError), so a forged or
  // mismatched identity cannot reach assembly.
  const subject = await authorize(exec, orgId, actorId, employmentId);
  const stable: EmploymentStableRow = {
    id: subject.id,
    orgId: subject.orgId,
    workerPartyId: subject.workerPartyId,
    employerSubsidiaryId: subject.employerSubsidiaryId,
    revision: subject.revision,
  };

  const versionResult = await exec.execute<EmploymentVersionRowRaw>(sql`
    select version_no, status,
           effective_from::text as effective_from,
           effective_to::text as effective_to,
           to_char(recorded_at at time zone 'UTC', ${RECORDED_TEXT}) as recorded_at,
           to_char(recorded_until at time zone 'UTC', ${RECORDED_TEXT}) as recorded_until
      from worker_employment_versions
     where org_id = ${orgId}::uuid and employment_id = ${employmentId}::uuid
     order by version_no`);
  const employmentVersions: EmploymentVersionRow[] = versionResult.rows.map((row) => ({
    versionNo: row.version_no,
    status: row.status,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    recordedAt: row.recorded_at,
    recordedUntil: row.recorded_until,
  }));

  const slotResult = await exec.execute<AssignmentSlotRowRaw>(sql`
    select id::text as id, assignment_key
      from employment_assignments
     where org_id = ${orgId}::uuid and employment_id = ${employmentId}::uuid
     order by assignment_key`);
  const slots: { slot: AssignmentSlotRow; versions: AssignmentVersionRow[] }[] = [];
  for (const slotRow of slotResult.rows) {
    const assignmentVersions = await exec.execute<AssignmentVersionRowRaw>(sql`
      select version_no, job_title,
             department_id::text as department_id,
             location_id::text as location_id,
             fte::text as fte, is_primary,
             effective_from::text as effective_from,
             effective_to::text as effective_to,
             to_char(recorded_at at time zone 'UTC', ${RECORDED_TEXT}) as recorded_at,
             to_char(recorded_until at time zone 'UTC', ${RECORDED_TEXT}) as recorded_until
        from employment_assignment_versions
       where org_id = ${orgId}::uuid and assignment_id = ${slotRow.id}::uuid
       order by version_no`);
    slots.push({
      slot: { id: slotRow.id, assignmentKey: slotRow.assignment_key },
      versions: assignmentVersions.rows.map((row) => ({
        versionNo: row.version_no,
        jobTitle: row.job_title,
        departmentId: row.department_id,
        locationId: row.location_id,
        fte: row.fte,
        isPrimary: row.is_primary,
        effectiveFrom: row.effective_from,
        effectiveTo: row.effective_to,
        recordedAt: row.recorded_at,
        recordedUntil: row.recorded_until,
      })),
    });
  }

  const assembled = assembleEmploymentAsOf(
    stable,
    employmentVersions,
    slots,
    { effectiveDate: query.effectiveDate, knownAt: query.knownAt },
  );
  if (assembled.employmentId !== employmentId || assembled.orgId !== orgId) {
    throw new EmploymentReadError(
      `assembled employment does not match the requested organization and employment; refusing to return it`,
    );
  }
  return assembled;
}

/**
 * Public boundary: one tenant-scoped transaction, the authoritative HRM
 * feature gate rechecked inside it, then the authorized as-of read. Read
 * only: no mutations, no payroll fanout, no party/role fallback.
 */
export async function getEmploymentAsOf(
  query: EmploymentAsOfQuery,
  deps: { authorize?: AuthorizeEmploymentRead } = {},
): Promise<EmploymentDTO> {
  const authorize = deps.authorize ?? requireHrmEmploymentRead;
  const orgId = requireId("orgId", query.orgId);
  return withOrgTransaction(orgId, async () => {
    if (!(await lockAndCheckOrgFeature(db, orgId, HRM_FEATURE_KEY))) {
      throw new EmploymentReadError(
        `hrm feature is disabled: enable it on Company Settings → Features before reading employment`,
      );
    }
    return loadEmploymentAsOf(db, query, authorize);
  });
}

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
 * zero applicable revisions for the employment itself is a refusal, more
 * than one is a refusal. An optional assignment with zero applicable
 * revisions at the as-of point is legitimately absent, never a failure:
 * the known view is selected first, then applicable slots. Never resolves
 * through JS Date: civil dates cross as YYYY-MM-DD text and recorded stamps
 * cross as exact UTC text projected in SQL with microsecond precision.
 *
 * Transaction contract (READ COMMITTED, asserted — not serializable):
 * versions and assignments are read in ONE statement (one snapshot), after
 * locking the aggregate stable row FOR SHARE. The lock serializes against
 * concurrent corrections only under the writer protocol: canonical writers
 * must update or lock the worker_employments row on every version write
 * (the stable revision column exists for that aggregate concurrency). Even
 * without writer cooperation the single snapshot keeps versions, assignments
 * and the displayed revision mutually consistent; only cross-transaction
 * serialization then depends on the protocol.
 *
 * Boundary: getEmploymentAsOf owns withOrgTransaction plus the authoritative
 * HRM feature gate (key `hrm`, registered in the coherent integration; the
 * gate fails closed until then). Authorization is hardwired to the auth
 * owner's requireHrmEmploymentRead — no caller-supplied authorizer exists at
 * any boundary, so production callers cannot swap or bypass it. The branded
 * trusted subject is reused in-transaction and never re-read for authority.
 */

import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../db.ts";
import { lockAndCheckOrgFeature } from "../org-feature-lock.ts";
import { requireHrmEmploymentRead } from "./authorization.ts";
import {
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
  /** Version row id (uuid text): the historical source-snapshot handle. */
  readonly id: string;
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
  /** Version row id (uuid text): the historical source-snapshot handle. */
  readonly id: string;
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
  /** Version row id for historical source snapshots (not just the number). */
  readonly versionId: string;
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
  /** Version row id for historical source snapshots (not just the number). */
  readonly versionId: string;
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

function requireText(field: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new EmploymentReadError(`${field} must be projected as non-empty text; check the snapshot column projection`);
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
): RecordedRevision<{ id: string; versionNo: number; status: string }>[] {
  return rows.map((row) => ({
    effective: { start: parseCivilDate(row.effectiveFrom), end: row.effectiveTo === null ? null : parseCivilDate(row.effectiveTo) },
    recordedAt: row.recordedAt,
    recordedUntil: row.recordedUntil,
    payload: { id: row.id, versionNo: row.versionNo, status: row.status },
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
 * all returned; at most one may be primary.
 *
 * Absence rule: the known view comes first. A slot whose versions leave no
 * revision live at knownAt — not yet recorded then, or already superseded
 * and replaced — is legitimately absent and is excluded, even when its
 * effective window covers the date. Only the employment itself has a
 * presence invariant: zero applicable employment revisions is a refusal.
 * More than one applicable revision at either level is refused.
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
    let live;
    try {
      live = resolveAsOf(toAssignmentRevisions(versions), {
        effective: query.effectiveDate,
        asKnown: query.knownAt,
      });
    } catch (error) {
      // Unknown at knownAt, or holding nothing on the effective date:
      // legitimate absence of an optional assignment, not a gap failure.
      if (error instanceof NoRevisionError) continue;
      throw error;
    }
    const row = live.payload;
    if (typeof row.fte !== "string" || row.fte.length === 0) {
      throw new EmploymentReadError(
        `assignment ${slot.id} version ${row.versionNo} has no precise fte text; re-read the row as fte::text`,
      );
    }
    assignments.push({
      assignmentId: slot.id,
      assignmentKey: slot.assignmentKey,
      versionId: row.id,
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
      versionId: resolved.payload.id,
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

/** One row of the single-statement snapshot: json aggregates, never JS Date. */
type SnapshotRow = {
  revision: number;
  employment_versions: EmploymentVersionJson[] | null;
  assignment_versions: AssignmentVersionJson[] | null;
}

interface EmploymentVersionJson {
  id: string;
  version_no: number;
  status: string;
  effective_from: string;
  effective_to: string | null;
  recorded_at: string;
  recorded_until: string | null;
}

interface AssignmentVersionJson {
  id: string;
  assignment_id: string;
  assignment_key: string;
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

function mapEmploymentVersions(rows: readonly EmploymentVersionJson[]): EmploymentVersionRow[] {
  return rows.map((row) => ({
    id: requireText("worker_employment_versions.id", row.id),
    versionNo: row.version_no,
    status: requireText("worker_employment_versions.status", row.status),
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    recordedAt: row.recorded_at,
    recordedUntil: row.recorded_until,
  }));
}

/**
 * Group every assignment version fetched for the employment by its stable
 * slot identity. One statement, no per-slot N+1. A key mismatch inside one
 * stable id cannot happen under the slot foreign key; refuse if it does.
 */
function groupAssignmentVersions(
  rows: readonly AssignmentVersionJson[],
): { slot: AssignmentSlotRow; versions: AssignmentVersionRow[] }[] {
  const grouped = new Map<string, { slot: AssignmentSlotRow; versions: AssignmentVersionRow[] }>();
  for (const row of rows) {
    const id = requireText("employment_assignment_versions.assignment_id", row.assignment_id);
    const key = requireText("employment_assignments.assignment_key", row.assignment_key);
    let entry = grouped.get(id);
    if (!entry) {
      entry = { slot: { id, assignmentKey: key }, versions: [] };
      grouped.set(id, entry);
    } else if (entry.slot.assignmentKey !== key) {
      throw new EmploymentReadError(
        `assignment ${id} carries two keys (${entry.slot.assignmentKey}, ${key}); refusing a forked stable identity`,
      );
    }
    entry.versions.push({
      id: requireText("employment_assignment_versions.id", row.id),
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
    });
  }
  return [...grouped.values()];
}

/**
 * Load and assemble inside the caller's transaction (RLS applies), with
 * authorization hardwired: requireHrmEmploymentRead is the only gate and no
 * parameter can replace it. Missing/wrong-org/out-of-scope subjects are
 * refused inside the gate (HrmAuthorizationError).
 *
 * Gate-free of the feature key by design, but NOT reusable with foreign
 * authority: a future internal payroll canonical resolver must bring its own
 * permission boundary and reuse the pure assembler below, never this loader.
 * Only the HRM user entry (getEmploymentAsOf) carries the HRM feature gate,
 * so payroll stays independently usable while HRM is off, and no payroll
 * dependency is read into the shared pure resolution.
 */
export async function loadEmploymentAsOf(
  exec: SqlExecutor,
  query: EmploymentAsOfQuery,
): Promise<EmploymentDTO> {
  const orgId = requireId("orgId", query.orgId);
  const actorId = requireId("actorId", query.actorId);
  const employmentId = requireId("employmentId", query.employmentId);
  validateAsOf(query.effectiveDate, query.knownAt);

  // Authority first: denial (including unknown id) reports uniformly, so a
  // later presence check cannot leak existence to an unauthorized actor.
  // The trusted subject supplies identity; the displayed revision comes from
  // the snapshot below so it can never mix with another snapshot's versions.
  const subject = await requireHrmEmploymentRead(exec, orgId, actorId, employmentId);

  // Aggregate lock: serializes against corrections that honor the writer
  // protocol (update or lock the stable row on every version write).
  const locked = (await exec.execute<{ one: number }>(sql`
    select 1 as one from worker_employments
     where org_id = ${orgId}::uuid and id = ${employmentId}::uuid for share`)).rows[0] ?? null;
  if (locked === null) {
    throw new EmploymentReadError(
      `employment not found: the authorized employment has no worker_employments row; refusing to assemble versions without their aggregate`,
    );
  }

  // One statement, one snapshot: stable revision, every employment version,
  // and every assignment version for the employment (joined to its slot key).
  // No arbitrary SQL identifiers: every value is a bound parameter, every
  // column list is explicit, stamps are microsecond UTC text, fte is text.
  const snapshot = (await exec.execute<SnapshotRow>(sql`
    select
      (select w.revision from worker_employments w
        where w.org_id = ${orgId}::uuid and w.id = ${employmentId}::uuid) as revision,
      coalesce((select json_agg(row_to_json(v)) from (
        select ev.id::text as id, ev.version_no, ev.status,
               ev.effective_from::text as effective_from,
               ev.effective_to::text as effective_to,
               to_char(ev.recorded_at at time zone 'UTC', ${RECORDED_TEXT}) as recorded_at,
               to_char(ev.recorded_until at time zone 'UTC', ${RECORDED_TEXT}) as recorded_until
          from worker_employment_versions ev
         where ev.org_id = ${orgId}::uuid and ev.employment_id = ${employmentId}::uuid
         order by ev.version_no) v), '[]'::json) as employment_versions,
      coalesce((select json_agg(row_to_json(a)) from (
        select av.id::text as id,
               av.assignment_id::text as assignment_id, a.assignment_key,
               av.version_no, av.job_title,
               av.department_id::text as department_id,
               av.location_id::text as location_id,
               av.fte::text as fte, av.is_primary,
               av.effective_from::text as effective_from,
               av.effective_to::text as effective_to,
               to_char(av.recorded_at at time zone 'UTC', ${RECORDED_TEXT}) as recorded_at,
               to_char(av.recorded_until at time zone 'UTC', ${RECORDED_TEXT}) as recorded_until
          from employment_assignment_versions av
          join employment_assignments a
            on a.id = av.assignment_id and a.org_id = av.org_id
         where av.org_id = ${orgId}::uuid and av.employment_id = ${employmentId}::uuid
         order by av.assignment_id, av.version_no) a), '[]'::json) as assignment_versions`)).rows[0];
  if (!snapshot || snapshot.revision === null) {
    throw new EmploymentReadError(
      `employment snapshot missing: the locked aggregate returned no revision; refusing a version read without its aggregate`,
    );
  }

  const assembled = assembleEmploymentAsOf(
    {
      id: subject.id,
      orgId: subject.orgId,
      workerPartyId: subject.workerPartyId,
      employerSubsidiaryId: subject.employerSubsidiaryId,
      revision: snapshot.revision,
    },
    mapEmploymentVersions(snapshot.employment_versions ?? []),
    groupAssignmentVersions(snapshot.assignment_versions ?? []),
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
export async function getEmploymentAsOf(query: EmploymentAsOfQuery): Promise<EmploymentDTO> {
  const orgId = requireId("orgId", query.orgId);
  return withOrgTransaction(orgId, async () => {
    if (!(await lockAndCheckOrgFeature(db, orgId, HRM_FEATURE_KEY))) {
      throw new EmploymentReadError(
        `hrm feature is disabled: enable it on Company Settings → Features before reading employment`,
      );
    }
    return loadEmploymentAsOf(db, query);
  });
}

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
 * owner's requireEmploymentOrTeamSubject — the employment read grant first,
 * then the structural team fallback for a manager's direct reports — and no
 * caller-supplied authorizer exists at any boundary, so production callers
 * cannot swap or bypass it. The branded trusted subject is reused
 * in-transaction and never re-read for authority.
 */

import { sql } from "drizzle-orm";
import { actorHasPermission } from "../organization/actor-permissions.ts";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { HrmAuthorizationError, requireEmploymentOrTeamSubject } from "./authorization.ts";
import {
  NoRevisionError,
  parseCivilDate,
  resolveAsOf,
  AmbiguousRevisionError,
  TemporalError,
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
 * The locked single-statement snapshot shared by every per-employment
 * loader: the aggregate lock plus stable revision, every employment
 * version, and every assignment version (joined to its slot key). Factored
 * out of loadEmploymentAsOf verbatim — the SQL text is unchanged — so the
 * episodes list and the combined record read observe the same snapshot
 * shape the as-of read assembles from.
 */
async function loadEmploymentSnapshot(
  exec: SqlExecutor,
  orgId: string,
  employmentId: string,
): Promise<{ revision: number; employmentVersions: EmploymentVersionRow[]; slots: { slot: AssignmentSlotRow; versions: AssignmentVersionRow[] }[] }> {
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

  return {
    revision: snapshot.revision,
    employmentVersions: mapEmploymentVersions(snapshot.employment_versions ?? []),
    slots: groupAssignmentVersions(snapshot.assignment_versions ?? []),
  };
}

/**
 * Load and assemble inside the caller's transaction (RLS applies), with
 * authorization hardwired: requireEmploymentOrTeamSubject is the only gate
 * (employment read, then the structural team fallback) and no parameter
 * can replace it. Missing/wrong-org/out-of-scope subjects are refused
 * inside the gate (HrmAuthorizationError — the fallback rethrows the
 * original employment refusal, so the error shape never changes).
 *
 * Gate-free of the feature key by design, but NOT reusable with foreign
 * authority: a future internal payroll canonical resolver must bring its own
 * permission boundary and reuse the pure assembler below, never this loader.
 * Only the HRM user entries (getEmploymentAsOf, getEmploymentRecord,
 * getHeadcountAsOf, findEmploymentsByParty) carry the HRM feature gate,
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
  const subject = await requireEmploymentOrTeamSubject(exec, orgId, actorId, employmentId);
  const snapshot = await loadEmploymentSnapshot(exec, orgId, employmentId);

  const assembled = assembleEmploymentAsOf(
    {
      id: subject.id,
      orgId: subject.orgId,
      workerPartyId: subject.workerPartyId,
      employerSubsidiaryId: subject.employerSubsidiaryId,
      revision: snapshot.revision,
    },
    snapshot.employmentVersions,
    snapshot.slots,
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
    await assertHrmFeatureOn(db, orgId);
    return loadEmploymentAsOf(db, query);
  });
}

/** The HRM feature gate rechecked inside the caller's transaction. Every
 * public read entry carries it; loaders stay gate-free so one transaction
 * pays for one check. */
async function assertHrmFeatureOn(exec: SqlExecutor, orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(exec, orgId, HRM_FEATURE_KEY))) {
    throw new EmploymentReadError(
      `hrm feature is disabled: enable it on Company Settings → Features before reading employment`,
    );
  }
}

/**
 * The aggregate half of HRM read authority: the same two checks
 * requireHrmEmploymentRead applies per employment — the hrm.employment.read
 * grant, then the employer-subsidiary scope — lifted to list-shaped reads
 * that name no single employment. Denial throws HrmAuthorizationError with
 * the same remedy; scope returns the allowed employer set (null =
 * unrestricted) for the caller to filter by, never a boolean to trust.
 */
async function requireAggregateEmploymentRead(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
): Promise<Set<string> | null> {
  if (!(await actorHasPermission(exec, orgId, actorId, "hrm.employment.read"))) {
    throw new HrmAuthorizationError(
      `Employment access requires the hrm.employment.read permission — ask an administrator to grant it in /admin/roles.`,
    );
  }
  return actorAllowedSubsidiaryIds(exec, orgId, actorId);
}

/** One employment version row: an episode of the employment's history. */
export interface EmploymentEpisodeDTO {
  /** Version row id for historical source snapshots (not just the number). */
  readonly versionId: string;
  readonly versionNo: number;
  readonly status: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly recordedAt: string;
  readonly recordedUntil: string | null;
}

export interface EmploymentEpisodesDTO {
  readonly employmentId: string;
  readonly revision: number;
  readonly episodes: readonly EmploymentEpisodeDTO[];
}

/**
 * List every recorded version (episode) of one employment, oldest first.
 * Authorized through requireEmploymentOrTeamSubject, so a missing,
 * foreign-org, or out-of-scope employment is refused uniformly
 * (HrmAuthorizationError), never an empty list pretending the employment
 * does not exist. An employment with no versions lists none — the as-of
 * read then refuses with NO_REVISION, which names the remedy.
 */
export async function loadEmploymentEpisodes(
  exec: SqlExecutor,
  query: Pick<EmploymentAsOfQuery, "orgId" | "actorId" | "employmentId">,
): Promise<EmploymentEpisodesDTO> {
  const orgId = requireId("orgId", query.orgId);
  const actorId = requireId("actorId", query.actorId);
  const employmentId = requireId("employmentId", query.employmentId);
  const subject = await requireEmploymentOrTeamSubject(exec, orgId, actorId, employmentId);
  const snapshot = await loadEmploymentSnapshot(exec, orgId, employmentId);
  const episodes = snapshot.employmentVersions
    .map((row) => ({
      versionId: row.id,
      versionNo: row.versionNo,
      status: row.status,
      effectiveFrom: row.effectiveFrom,
      effectiveTo: row.effectiveTo,
      recordedAt: row.recordedAt,
      recordedUntil: row.recordedUntil,
    }))
    .sort((a, b) => a.versionNo - b.versionNo);
  return { employmentId: subject.id, revision: snapshot.revision, episodes };
}

/** One 0185 change-request row: status, revision binding, and the native
 * approval-run anchor. Read-only projection of the request table — Slice A
 * owns authoring; this loader never writes. */
export interface EmploymentChangeRequestDTO {
  readonly id: string;
  readonly status: string;
  readonly requestRevision: number;
  readonly expectedEmploymentRevision: number;
  readonly payloadSchemaVersion: string;
  readonly reason: string | null;
  /** Generic HR action (0227); null when unclassified. */
  readonly action: string | null;
  /** Reason code (0227); null when unclassified. */
  readonly reasonCode: string | null;
  readonly submittedBy: string | null;
  readonly submittedAt: string | null;
  /** Native approval run anchor; null in draft (drafts never carry a run). */
  readonly flowRunId: string | null;
  readonly decisionSnapshot: unknown;
  readonly appliedAt: string | null;
  readonly appliedBy: string | null;
  readonly appliedEmploymentRevision: number | null;
  readonly appliedEmploymentChangeId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

type ChangeRequestJson = {
  id: string;
  status: string;
  request_revision: number;
  expected_employment_revision: number;
  payload_schema_version: string;
  reason: string | null;
  action: string | null;
  reason_code: string | null;
  submitted_by: string | null;
  submitted_at: string | null;
  flow_run_id: string | null;
  decision_snapshot: unknown;
  applied_at: string | null;
  applied_by: string | null;
  applied_employment_revision: number | null;
  applied_employment_change_id: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * List the employment's change requests, newest first. Authorized through
 * requireEmploymentOrTeamSubject, so a missing, foreign-org, or out-of-scope
 * employment is refused uniformly (HrmAuthorizationError). An employment
 * with no requests lists none — a truthful empty, not a refusal.
 */
export async function loadEmploymentChangeRequests(
  exec: SqlExecutor,
  query: Pick<EmploymentAsOfQuery, "orgId" | "actorId" | "employmentId">,
): Promise<readonly EmploymentChangeRequestDTO[]> {
  const orgId = requireId("orgId", query.orgId);
  const actorId = requireId("actorId", query.actorId);
  const employmentId = requireId("employmentId", query.employmentId);
  await requireEmploymentOrTeamSubject(exec, orgId, actorId, employmentId);
  // No arbitrary SQL identifiers: every value is a bound parameter, every
  // column list is explicit, stamps are microsecond UTC text, uuids are text.
  const rows = (await exec.execute<ChangeRequestJson>(sql`
    select r.id::text as id, r.status,
           r.request_revision, r.expected_employment_revision,
           r.payload_schema_version, r.reason, r.action, r.reason_code,
           r.submitted_by::text as submitted_by,
           to_char(r.submitted_at at time zone 'UTC', ${RECORDED_TEXT}) as submitted_at,
           r.flow_run_id::text as flow_run_id,
           r.decision_snapshot,
           to_char(r.applied_at at time zone 'UTC', ${RECORDED_TEXT}) as applied_at,
           r.applied_by::text as applied_by,
           r.applied_employment_revision,
           r.applied_employment_change_id::text as applied_employment_change_id,
           to_char(r.created_at at time zone 'UTC', ${RECORDED_TEXT}) as created_at,
           to_char(r.updated_at at time zone 'UTC', ${RECORDED_TEXT}) as updated_at
      from hrm_employment_change_requests r
     where r.org_id = ${orgId}::uuid and r.employment_id = ${employmentId}::uuid
     order by r.created_at desc, r.id desc`)).rows;
  return rows.map((row) => ({
    id: requireText("hrm_employment_change_requests.id", row.id),
    status: requireText("hrm_employment_change_requests.status", row.status),
    requestRevision: row.request_revision,
    expectedEmploymentRevision: row.expected_employment_revision,
    payloadSchemaVersion: row.payload_schema_version,
    reason: row.reason,
    action: row.action,
    reasonCode: row.reason_code,
    submittedBy: row.submitted_by,
    submittedAt: row.submitted_at,
    flowRunId: row.flow_run_id,
    decisionSnapshot: row.decision_snapshot,
    appliedAt: row.applied_at,
    appliedBy: row.applied_by,
    appliedEmploymentRevision: row.applied_employment_revision,
    appliedEmploymentChangeId: row.applied_employment_change_id,
    createdAt: requireText("hrm_employment_change_requests.created_at", row.created_at),
    updatedAt: requireText("hrm_employment_change_requests.updated_at", row.updated_at),
  }));
}

export interface EmploymentsByPartyQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly workerPartyId: string;
}

/**
 * Resolve a worker party to its employment ids, in stable order. Authority
 * is the aggregate half (grant + employer-subsidiary scope): employments
 * outside the actor's scope are filtered, never returned. An empty list is
 * truthful — most parties hold no 0184 employment row (no backfill) — and
 * the caller renders the explicit no-record state, never data. More than
 * one id is the caller's ambiguity to refuse: identity is per employment.
 */
export async function loadEmploymentsByParty(
  exec: SqlExecutor,
  query: EmploymentsByPartyQuery,
): Promise<readonly string[]> {
  const orgId = requireId("orgId", query.orgId);
  const actorId = requireId("actorId", query.actorId);
  const workerPartyId = requireId("workerPartyId", query.workerPartyId);
  const allowed = await requireAggregateEmploymentRead(exec, orgId, actorId);
  const rows = (await exec.execute<{ id: string; employerSubsidiaryId: string | null }>(sql`
    select id::text as id, employer_subsidiary_id::text as "employerSubsidiaryId"
      from worker_employments
     where org_id = ${orgId}::uuid and worker_party_id = ${workerPartyId}::uuid
     order by id`)).rows;
  // A null employer is invisible — authorization refuses such subjects, so
  // the list twin excludes them rather than leaking their ids.
  return rows
    .filter((row) => row.employerSubsidiaryId !== null && (allowed === null || allowed.has(row.employerSubsidiaryId)))
    .map((row) => requireText("worker_employments.id", row.id));
}

/**
 * Public boundary: one tenant-scoped transaction, the authoritative HRM
 * feature gate rechecked inside it, then the scoped party→employment
 * resolution. Read only.
 */
export async function findEmploymentsByParty(query: EmploymentsByPartyQuery): Promise<readonly string[]> {
  const orgId = requireId("orgId", query.orgId);
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    return loadEmploymentsByParty(db, query);
  });
}

/** A computed as-of refusal carried as data, so the record read can refuse
 * one section while still returning the others. Exactly one of `asOf` /
 * `asOfRefusal` is set; `code` is the error name (NoRevisionError,
 * AmbiguousRevisionError, EmploymentReadError). */
export interface EmploymentAsOfRefusal {
  readonly code: string;
  readonly message: string;
}

export interface EmploymentRecordDTO {
  readonly employmentId: string;
  readonly orgId: string;
  readonly workerPartyId: string;
  readonly employerSubsidiaryId: string;
  readonly revision: number;
  readonly episodes: readonly EmploymentEpisodeDTO[];
  readonly asOf: EmploymentDTO | null;
  readonly asOfRefusal: EmploymentAsOfRefusal | null;
  readonly changeRequests: readonly EmploymentChangeRequestDTO[];
}

/**
 * Public boundary: one tenant-scoped transaction, the authoritative HRM
 * feature gate rechecked inside it, then episodes, the as-of resolution,
 * and the change-request list from one snapshot point. Read only.
 *
 * The as-of leg may refuse (ambiguity, missing version) while the
 * employment itself is authorized: that refusal is returned as data in
 * `asOfRefusal` so the caller renders it as a refusal beside the episodes
 * and requests — never an empty state pretending to be data. Authorization
 * denial refuses the whole call (HrmAuthorizationError): nothing about an
 * employment the actor cannot see is returned piecemeal.
 */
export async function getEmploymentRecord(query: EmploymentAsOfQuery): Promise<EmploymentRecordDTO> {
  const orgId = requireId("orgId", query.orgId);
  const actorId = requireId("actorId", query.actorId);
  const employmentId = requireId("employmentId", query.employmentId);
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    // One pinned client inside the transaction: sequential, never parallel.
    const subject = await requireEmploymentOrTeamSubject(db, orgId, actorId, employmentId);
    const episodes = await loadEmploymentEpisodes(db, { orgId, actorId, employmentId });
    let asOf: EmploymentDTO | null = null;
    let asOfRefusal: EmploymentAsOfRefusal | null = null;
    try {
      asOf = await loadEmploymentAsOf(db, query);
    } catch (error) {
      if (error instanceof TemporalError || error instanceof EmploymentReadError) {
        asOfRefusal = { code: (error as Error).name, message: (error as Error).message };
      } else {
        throw error;
      }
    }
    if ((asOf === null) === (asOfRefusal === null)) {
      throw new EmploymentReadError(
        `employment record resolved neither to data nor to a refusal; refusing an envelope that asserts nothing`,
      );
    }
    const changeRequests = await loadEmploymentChangeRequests(db, { orgId, actorId, employmentId });
    return {
      employmentId: subject.id,
      orgId: subject.orgId,
      workerPartyId: subject.workerPartyId,
      employerSubsidiaryId: subject.employerSubsidiaryId,
      revision: episodes.revision,
      episodes: episodes.episodes,
      asOf,
      asOfRefusal,
      changeRequests,
    };
  });
}

export interface HeadcountQuery {
  readonly orgId: string;
  readonly actorId: string;
  /** Civil effective date (YYYY-MM-DD). */
  readonly effectiveDate: string;
  /** As-known UTC instant (YYYY-MM-DDTHH:mm:ss[.fraction]Z). */
  readonly knownAt: string;
}

export interface HeadcountGroupDTO {
  readonly employerSubsidiaryId: string;
  readonly employerSubsidiaryName: string;
  readonly departmentId: string | null;
  readonly departmentName: string | null;
  readonly headcount: number;
}

export interface HeadcountDTO {
  readonly orgId: string;
  readonly effectiveDate: string;
  readonly knownAt: string;
  readonly total: number;
  readonly groups: readonly HeadcountGroupDTO[];
}

export interface HeadcountTotalsQuery {
  readonly orgId: string;
  readonly actorId: string;
  /** Ordered civil dates (YYYY-MM-DD). The response preserves this order. */
  readonly effectiveDates: readonly string[];
  /** One as-known UTC instant shared by the entire comparable series. */
  readonly knownAt: string;
}

export interface HeadcountTotalPointDTO {
  readonly effectiveDate: string;
  readonly total: number;
}

export interface HeadcountTotalsDTO {
  readonly orgId: string;
  readonly knownAt: string;
  readonly points: readonly HeadcountTotalPointDTO[];
}

/**
 * Employment statuses counted toward headcount: in service, or retained
 * while on leave (leave is presence-neutral for headcount). Offered has not
 * commenced, suspended is interrupted, terminated has ended — resolved but
 * not counted. The rule is explicit and pinned by tests; changing it is a
 * product decision, not a bug fix.
 */
export const HEADCOUNT_STATUSES: readonly string[] = ["active", "on_leave"];

type HeadcountEmploymentRow = {
  id: string;
  workerPartyId: string;
  employerSubsidiaryId: string | null;
  revision: number;
};

// Standalone type aliases (not interfaces): drizzle's execute row generic
// requires Record<string, unknown>, which only object-literal type aliases
// satisfy through the implicit index signature.
type BatchedEmploymentVersionJson = {
  id: string;
  employment_id: string;
  version_no: number;
  status: string;
  effective_from: string;
  effective_to: string | null;
  recorded_at: string;
  recorded_until: string | null;
};

type BatchedAssignmentVersionJson = {
  id: string;
  employment_id: string;
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
};

interface HeadcountTemporalSource {
  readonly employments: readonly HeadcountEmploymentRow[];
  readonly versionsByEmployment: ReadonlyMap<string, readonly EmploymentVersionRow[]>;
  readonly assignmentsByEmployment: ReadonlyMap<string, readonly AssignmentVersionJson[]>;
}

interface CountedEmployment {
  readonly subsidiaryId: string;
  readonly departmentId: string | null;
}

/**
 * Load one authorized temporal census. A caller may resolve it at several
 * effective dates under one known-at snapshot without repeating database
 * reads. This is still the canonical temporal model, never a row count.
 */
async function loadHeadcountTemporalSource(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
): Promise<HeadcountTemporalSource> {
  const allowed = await requireAggregateEmploymentRead(exec, orgId, actorId);
  const employments = (await exec.execute<HeadcountEmploymentRow>(sql`
    select id::text as id,
           worker_party_id::text as "workerPartyId",
           employer_subsidiary_id::text as "employerSubsidiaryId",
           revision
      from worker_employments
     where org_id = ${orgId}::uuid
     order by id`)).rows.filter(
    (row) => row.employerSubsidiaryId !== null && (allowed === null || allowed.has(row.employerSubsidiaryId)),
  );
  if (employments.length === 0) {
    return {
      employments,
      versionsByEmployment: new Map(),
      assignmentsByEmployment: new Map(),
    };
  }

  // Bare JS arrays must never be interpolated into ANY() (they bind as row
  // constructors); each id is its own parameter in these two batched reads.
  const ids = employments.map((row) => sql`${row.id}::uuid`);
  const versionRows = (await exec.execute<BatchedEmploymentVersionJson>(sql`
    select ev.id::text as id, ev.employment_id::text as employment_id, ev.version_no,
           ev.status,
           ev.effective_from::text as effective_from,
           ev.effective_to::text as effective_to,
           to_char(ev.recorded_at at time zone 'UTC', ${RECORDED_TEXT}) as recorded_at,
           to_char(ev.recorded_until at time zone 'UTC', ${RECORDED_TEXT}) as recorded_until
      from worker_employment_versions ev
     where ev.org_id = ${orgId}::uuid and ev.employment_id in (${sql.join(ids, sql`, `)})
     order by ev.employment_id, ev.version_no`)).rows;
  const assignmentRows = (await exec.execute<BatchedAssignmentVersionJson>(sql`
    select av.id::text as id,
           av.employment_id::text as employment_id,
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
     where av.org_id = ${orgId}::uuid and av.employment_id in (${sql.join(ids, sql`, `)})
     order by av.employment_id, av.assignment_id, av.version_no`)).rows;

  const versionsByEmployment = new Map<string, EmploymentVersionRow[]>();
  for (const row of versionRows) {
    const list = versionsByEmployment.get(row.employment_id) ?? [];
    list.push({
      id: requireText("worker_employment_versions.id", row.id),
      versionNo: row.version_no,
      status: requireText("worker_employment_versions.status", row.status),
      effectiveFrom: row.effective_from,
      effectiveTo: row.effective_to,
      recordedAt: row.recorded_at,
      recordedUntil: row.recorded_until,
    });
    versionsByEmployment.set(row.employment_id, list);
  }
  const assignmentsByEmployment = new Map<string, AssignmentVersionJson[]>();
  for (const row of assignmentRows) {
    const list = assignmentsByEmployment.get(row.employment_id) ?? [];
    list.push(row);
    assignmentsByEmployment.set(row.employment_id, list);
  }
  return { employments, versionsByEmployment, assignmentsByEmployment };
}

function resolveCountedEmployments(
  source: HeadcountTemporalSource,
  orgId: string,
  effectiveDate: string,
  knownAt: string,
): CountedEmployment[] {
  const counted: CountedEmployment[] = [];
  for (const employment of source.employments) {
    const stable: EmploymentStableRow = {
      id: employment.id,
      orgId,
      workerPartyId: employment.workerPartyId,
      employerSubsidiaryId: employment.employerSubsidiaryId ?? "",
      revision: employment.revision,
    };
    let dto: EmploymentDTO;
    try {
      dto = assembleEmploymentAsOf(
        stable,
        source.versionsByEmployment.get(employment.id) ?? [],
        groupAssignmentVersions(source.assignmentsByEmployment.get(employment.id) ?? []),
        { effectiveDate, knownAt },
      );
    } catch (error) {
      // Not employed at the as-of point (not yet effective, already ended):
      // legitimately absent from headcount, never a gap failure. Ambiguity
      // (or any other refusal) propagates and fails the whole read.
      if (error instanceof NoRevisionError) continue;
      throw error;
    }
    if (!HEADCOUNT_STATUSES.includes(dto.version.status)) continue;
    counted.push({
      subsidiaryId: dto.employerSubsidiaryId,
      departmentId: dto.assignments.find((assignment) => assignment.isPrimary)?.departmentId ?? null,
    });
  }
  return counted;
}

/**
 * Headcount as-of (effectiveDate, knownAt) by employer subsidiary and
 * primary-assignment department, resolved through the temporal primitives —
 * never a row count. Every in-scope employment resolves through
 * assembleEmploymentAsOf: no applicable revision is legitimately absent
 * (not employed at the as-of point), more than one is a refusal that fails
 * the whole read (AmbiguousRevisionError names the employment) rather than
 * a silently undercounted cockpit. Authority is the aggregate half (grant
 * + employer-subsidiary scope). A referenced subsidiary or department with
 * no name row is a refusal: headcount must never be misattributed.
 */
export async function loadHeadcountAsOf(exec: SqlExecutor, query: HeadcountQuery): Promise<HeadcountDTO> {
  const orgId = requireId("orgId", query.orgId);
  const actorId = requireId("actorId", query.actorId);
  validateAsOf(query.effectiveDate, query.knownAt);
  const source = await loadHeadcountTemporalSource(exec, orgId, actorId);
  const counted = resolveCountedEmployments(source, orgId, query.effectiveDate, query.knownAt);
  if (counted.length === 0) {
    // Nothing in service at the as-of point: a resolved zero, and never an
    // empty IN list (which PostgreSQL rejects) on the name lookups below.
    return { orgId, effectiveDate: query.effectiveDate, knownAt: query.knownAt, total: 0, groups: [] };
  }

  const subsidiaryIds = [...new Set(counted.map((row) => row.subsidiaryId))];
  const departmentIds = [...new Set(counted.map((row) => row.departmentId).filter((id): id is string => id !== null))];
  const subsidiaryNames = new Map(
    (await exec.execute<{ id: string; name: string }>(sql`
      select id::text as id, name from subsidiaries
       where org_id = ${orgId}::uuid and id in (${sql.join(subsidiaryIds.map((id) => sql`${id}::uuid`), sql`, `)})`)).rows.map(
      (row) => [row.id, row.name] as const,
    ),
  );
  const departmentNames = departmentIds.length === 0
    ? new Map<string, string>()
    : new Map(
        (await exec.execute<{ id: string; name: string }>(sql`
          select id::text as id, name from departments
           where org_id = ${orgId}::uuid and id in (${sql.join(departmentIds.map((id) => sql`${id}::uuid`), sql`, `)})`)).rows.map(
          (row) => [row.id, row.name] as const,
        ),
      );
  const grouped = new Map<string, HeadcountGroupDTO>();
  for (const row of counted) {
    const subsidiaryName = subsidiaryNames.get(row.subsidiaryId);
    if (subsidiaryName === undefined) {
      throw new EmploymentReadError(
        `headcount references subsidiary ${row.subsidiaryId} with no subsidiaries row; refusing a misattributed count`,
      );
    }
    let departmentName: string | null = null;
    if (row.departmentId !== null) {
      const resolved = departmentNames.get(row.departmentId);
      if (resolved === undefined) {
        throw new EmploymentReadError(
          `headcount references department ${row.departmentId} with no departments row; refusing a misattributed count`,
        );
      }
      departmentName = resolved;
    }
    const key = `${row.subsidiaryId} ${row.departmentId ?? ""}`;
    const existing = grouped.get(key);
    if (existing) {
      grouped.set(key, { ...existing, headcount: existing.headcount + 1 });
    } else {
      grouped.set(key, {
        employerSubsidiaryId: row.subsidiaryId,
        employerSubsidiaryName: subsidiaryName,
        departmentId: row.departmentId,
        departmentName,
        headcount: 1,
      });
    }
  }
  // Deterministic order: subsidiary name, then department name with
  // unattributed rows last. Key comparison is total: names are unique per
  // group key by construction (one name row per id).
  const groups = [...grouped.values()].sort((a, b) => {
    if (a.employerSubsidiaryName !== b.employerSubsidiaryName) {
      return a.employerSubsidiaryName < b.employerSubsidiaryName ? -1 : 1;
    }
    if (a.departmentName === b.departmentName) return 0;
    if (a.departmentName === null) return 1;
    if (b.departmentName === null) return -1;
    return a.departmentName < b.departmentName ? -1 : 1;
  });
  return {
    orgId,
    effectiveDate: query.effectiveDate,
    knownAt: query.knownAt,
    total: counted.length,
    groups,
  };
}

const MAX_HEADCOUNT_TOTAL_DATES = 24;

/**
 * Resolve a bounded headcount series from one authorized temporal census.
 * Database work is constant with respect to the number of dates: permission,
 * scope, employments, versions, and assignments are each loaded once.
 */
export async function loadHeadcountTotalsAsOf(
  exec: SqlExecutor,
  query: HeadcountTotalsQuery,
): Promise<HeadcountTotalsDTO> {
  const orgId = requireId("orgId", query.orgId);
  const actorId = requireId("actorId", query.actorId);
  if (!Array.isArray(query.effectiveDates) || query.effectiveDates.length === 0) {
    throw new EmploymentReadError("effectiveDates must contain at least one civil date");
  }
  if (query.effectiveDates.length > MAX_HEADCOUNT_TOTAL_DATES) {
    throw new EmploymentReadError(
      `effectiveDates may contain at most ${MAX_HEADCOUNT_TOTAL_DATES} dates per headcount series`,
    );
  }
  for (const effectiveDate of query.effectiveDates) validateAsOf(effectiveDate, query.knownAt);

  const source = await loadHeadcountTemporalSource(exec, orgId, actorId);
  return {
    orgId,
    knownAt: query.knownAt,
    points: query.effectiveDates.map((effectiveDate) => ({
      effectiveDate,
      total: resolveCountedEmployments(source, orgId, effectiveDate, query.knownAt).length,
    })),
  };
}

/**
 * Public boundary: one tenant-scoped transaction, the authoritative HRM
 * feature gate rechecked inside it, then the authorized headcount. Read
 * only: no mutations, no payroll fanout, no party/role fallback.
 */
export async function getHeadcountAsOf(query: HeadcountQuery): Promise<HeadcountDTO> {
  const orgId = requireId("orgId", query.orgId);
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    return loadHeadcountAsOf(db, query);
  });
}

/** Public boundary for a bounded headcount trend under one known-at view. */
export async function getHeadcountTotalsAsOf(query: HeadcountTotalsQuery): Promise<HeadcountTotalsDTO> {
  const orgId = requireId("orgId", query.orgId);
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    return loadHeadcountTotalsAsOf(db, query);
  });
}

// --- Picker options (authoring support; read only) ---------------------------

/** Bounded page defaults shared by the authoring pickers: pages, never dumps. */
const OPTIONS_DEFAULT_LIMIT = 25;
const OPTIONS_MAX_LIMIT = 100;

function requireOptionsLimit(limit: number | undefined): number {
  const resolved = limit ?? OPTIONS_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > OPTIONS_MAX_LIMIT) {
    throw new EmploymentReadError(
      "options limit must be an integer from 1 to 100 — the picker pages, it never dumps the roster",
    );
  }
  return resolved;
}

/** Escape a free-text fragment for a LIKE pattern: % _ and \ match literally. */
export function likeEscape(fragment: string): string {
  return fragment.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export interface EmploymentOptionsQuery {
  readonly orgId: string;
  readonly actorId: string;
  /** Substring match on the worker's display name; empty matches all. */
  readonly q?: string;
  /** Bounded page size; defaults to 25, refuses above 100. */
  readonly limit?: number;
  /** Employment id to pin first (the draft's stored value under edit). */
  readonly includeEmploymentId?: string;
}

export interface EmploymentOptionDTO {
  readonly employmentId: string;
  readonly label: string;
}

/**
 * Employments holding people, for the line-manager picker. Authority is the
 * aggregate half (grant + employer-subsidiary scope): out-of-scope holders
 * are filtered, never returned. Labels name the person, the employer, and
 * the live primary job title when one exists — the drawer submits the
 * employment id, never a name. An empty page is truthful, never a refusal.
 */
export async function loadEmploymentOptions(
  exec: SqlExecutor,
  query: EmploymentOptionsQuery,
): Promise<readonly EmploymentOptionDTO[]> {
  const orgId = requireId("orgId", query.orgId);
  const actorId = requireId("actorId", query.actorId);
  const limit = requireOptionsLimit(query.limit);
  const allowed = await requireAggregateEmploymentRead(exec, orgId, actorId);
  const fragment = (query.q ?? "").trim();
  const includeId = query.includeEmploymentId?.trim() ? query.includeEmploymentId.trim() : null;

  type EmploymentOptionRow = {
    employmentId: string;
    employerSubsidiaryId: string;
    personName: string;
    employerName: string;
    jobTitle: string | null;
  };
  const page = (await exec.execute<EmploymentOptionRow>(sql`
    select e.id::text as "employmentId",
           e.employer_subsidiary_id::text as "employerSubsidiaryId",
           p.display_name as "personName",
           s.name as "employerName",
           jt.job_title as "jobTitle"
      from worker_employments e
      join parties p on p.org_id = e.org_id and p.id = e.worker_party_id
      join subsidiaries s on s.org_id = e.org_id and s.id = e.employer_subsidiary_id
      left join lateral (
        select av.job_title
          from employment_assignment_versions av
         where av.org_id = e.org_id
           and av.employment_id = e.id
           and av.recorded_until is null
           and av.is_primary
         order by av.version_no desc
         limit 1
      ) jt on true
     where e.org_id = ${orgId}::uuid
       and e.employer_subsidiary_id is not null
       ${fragment ? sql`and p.display_name ilike ${`%${likeEscape(fragment)}%`} escape '\\'` : sql``}
     order by p.display_name, e.id
     limit ${limit}`)).rows.filter(
    (row) => allowed === null || allowed.has(row.employerSubsidiaryId),
  );
  // The pinned draft value is read by id, never by page position: it leads
  // even when it falls outside the bounded page. An unknown or out-of-scope
  // id stays absent rather than leaking existence.
  const pinned = includeId
    ? (await exec.execute<EmploymentOptionRow>(sql`
      select e.id::text as "employmentId",
             e.employer_subsidiary_id::text as "employerSubsidiaryId",
             p.display_name as "personName",
             s.name as "employerName",
             jt.job_title as "jobTitle"
        from worker_employments e
        join parties p on p.org_id = e.org_id and p.id = e.worker_party_id
        join subsidiaries s on s.org_id = e.org_id and s.id = e.employer_subsidiary_id
        left join lateral (
          select av.job_title
            from employment_assignment_versions av
           where av.org_id = e.org_id
             and av.employment_id = e.id
             and av.recorded_until is null
             and av.is_primary
           order by av.version_no desc
           limit 1
        ) jt on true
       where e.org_id = ${orgId}::uuid
         and e.id = ${includeId}::uuid
         and e.employer_subsidiary_id is not null`)).rows.filter(
        (row) => allowed === null || allowed.has(row.employerSubsidiaryId),
      )[0] ?? null
    : null;
  const rows = pinned ? [pinned, ...page.filter((row) => row.employmentId !== pinned.employmentId)] : page;

  const toOption = (row: EmploymentOptionRow): EmploymentOptionDTO => ({
    employmentId: requireText("worker_employments.id", row.employmentId),
    label: row.jobTitle
      ? `${row.personName} · ${row.employerName} · ${row.jobTitle}`
      : `${row.personName} · ${row.employerName}`,
  });
  return rows.slice(0, limit + (pinned ? 1 : 0)).map(toOption);
}

/**
 * Public boundary: one tenant-scoped transaction, the authoritative HRM
 * feature gate rechecked inside it, then the scoped employment options.
 * Read only.
 */
export async function listEmploymentOptions(
  query: EmploymentOptionsQuery,
): Promise<readonly EmploymentOptionDTO[]> {
  const orgId = requireId("orgId", query.orgId);
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    return loadEmploymentOptions(db, query);
  });
}

export interface PeopleOptionsQuery {
  readonly orgId: string;
  readonly actorId: string;
  /** Substring match on the person's display name; empty matches all. */
  readonly q?: string;
  /** Bounded page size; defaults to 25, refuses above 100. */
  readonly limit?: number;
  /** Party id to pin first (the stored interviewer under edit). */
  readonly includePartyId?: string;
}

export interface PeopleOptionDTO {
  readonly partyId: string;
  readonly label: string;
}

/**
 * Directory people holding an employment, for the exit-interviewer picker
 * (F3-40): the exit record names its interviewer by party, so the picker
 * submits party ids, never employment ids or names. Authority is the
 * aggregate half (grant + employer-subsidiary scope), the same population
 * the employment picker already exposes — one holder, one row, whatever
 * their assignment history. An empty page is truthful, never a refusal.
 */
export async function loadPeopleOptions(
  exec: SqlExecutor,
  query: PeopleOptionsQuery,
): Promise<readonly PeopleOptionDTO[]> {
  const orgId = requireId("orgId", query.orgId);
  const actorId = requireId("actorId", query.actorId);
  const limit = requireOptionsLimit(query.limit);
  const allowed = await requireAggregateEmploymentRead(exec, orgId, actorId);
  const fragment = (query.q ?? "").trim();
  const includeId = query.includePartyId?.trim() ? query.includePartyId.trim() : null;

  type PeopleOptionRow = {
    partyId: string;
    subsidiaryIds: string[];
    personName: string;
  };
  // One holder, one row: the subsidiary list decides scope below — a
  // holder with any in-scope employment is listed (uuid has no min(), so
  // the scope projects as an array, never an aggregate).
  const inScope = (row: PeopleOptionRow): boolean =>
    allowed === null || row.subsidiaryIds.some((id) => allowed.has(id));
  const page = (await exec.execute<PeopleOptionRow>(sql`
    select p.id::text as "partyId",
           array_agg(distinct e.employer_subsidiary_id::text) as "subsidiaryIds",
           p.display_name as "personName"
      from parties p
      join worker_employments e
        on e.org_id = p.org_id and e.worker_party_id = p.id
     where p.org_id = ${orgId}::uuid
       and e.employer_subsidiary_id is not null
       ${fragment ? sql`and p.display_name ilike ${`%${likeEscape(fragment)}%`} escape '\\'` : sql``}
     group by p.id, p.display_name
     order by p.display_name
     limit ${limit}`)).rows.filter(inScope);
  // The pinned stored value is read by id, never by page position: it
  // leads even when it falls outside the bounded page. An unknown or
  // out-of-scope id stays absent rather than leaking existence.
  const pinned = includeId
    ? (await exec.execute<PeopleOptionRow>(sql`
      select p.id::text as "partyId",
             array_agg(distinct e.employer_subsidiary_id::text) as "subsidiaryIds",
             p.display_name as "personName"
        from parties p
        join worker_employments e
          on e.org_id = p.org_id and e.worker_party_id = p.id
       where p.org_id = ${orgId}::uuid
         and p.id = ${includeId}::uuid
         and e.employer_subsidiary_id is not null
       group by p.id, p.display_name`)).rows.filter(inScope)[0] ?? null
    : null;
  const rows = pinned ? [pinned, ...page.filter((row) => row.partyId !== pinned.partyId)] : page;

  const toOption = (row: PeopleOptionRow): PeopleOptionDTO => ({
    partyId: requireText("parties.id", row.partyId),
    label: row.personName,
  });
  return rows.slice(0, limit + (pinned ? 1 : 0)).map(toOption);
}

/** Public boundary: one tenant-scoped transaction, the HRM feature rechecked inside it. Read only. */
export async function listPeopleOptions(
  query: PeopleOptionsQuery,
): Promise<readonly PeopleOptionDTO[]> {
  const orgId = requireId("orgId", query.orgId);
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    return loadPeopleOptions(db, query);
  });
}

export interface LocationOptionsQuery {
  readonly orgId: string;
  readonly actorId: string;
  /** Substring match on the location name; empty matches all. */
  readonly q?: string;
  /** Bounded page size; defaults to 25, refuses above 100. */
  readonly limit?: number;
  /** Location id to pin first (the draft's stored value under edit). */
  readonly includeLocationId?: string;
}

export interface LocationOptionDTO {
  readonly locationId: string;
  readonly label: string;
}

/**
 * Active native locations (0184's employment_assignment_versions.location_id
 * references public.locations), for the assignment location picker. Same
 * aggregate authority as employments; org-wide (null-subsidiary) locations
 * are visible to every in-scope reader, subsidiary-assigned ones only
 * inside the actor's scope. Inactive locations never list — assignment
 * writes against them would fail closed downstream.
 */
export async function loadLocationOptions(
  exec: SqlExecutor,
  query: LocationOptionsQuery,
): Promise<readonly LocationOptionDTO[]> {
  const orgId = requireId("orgId", query.orgId);
  const actorId = requireId("actorId", query.actorId);
  const limit = requireOptionsLimit(query.limit);
  const allowed = await requireAggregateEmploymentRead(exec, orgId, actorId);
  const fragment = (query.q ?? "").trim();
  const includeId = query.includeLocationId?.trim() ? query.includeLocationId.trim() : null;

  type LocationOptionRow = {
    locationId: string;
    code: string | null;
    name: string;
    subsidiaryId: string | null;
  };
  const page = (await exec.execute<LocationOptionRow>(sql`
    select id::text as "locationId", code, name, subsidiary_id::text as "subsidiaryId"
      from locations
     where org_id = ${orgId}::uuid
       and is_active
       ${fragment ? sql`and name ilike ${`%${likeEscape(fragment)}%`} escape '\\'` : sql``}
     order by name, id
     limit ${limit}`)).rows.filter(
    (row) => row.subsidiaryId === null || allowed === null || allowed.has(row.subsidiaryId),
  );
  // The pinned draft value is read by id, never by page position: it leads
  // even when it falls outside the bounded page. An unknown, inactive, or
  // out-of-scope id stays absent rather than leaking existence.
  const pinned = includeId
    ? (await exec.execute<LocationOptionRow>(sql`
      select id::text as "locationId", code, name, subsidiary_id::text as "subsidiaryId"
        from locations
       where org_id = ${orgId}::uuid
         and id = ${includeId}::uuid
         and is_active`)).rows.filter(
        (row) => row.subsidiaryId === null || allowed === null || allowed.has(row.subsidiaryId),
      )[0] ?? null
    : null;
  const rows = pinned ? [pinned, ...page.filter((row) => row.locationId !== pinned.locationId)] : page;

  const toOption = (row: LocationOptionRow): LocationOptionDTO => ({
    locationId: requireText("locations.id", row.locationId),
    label: row.code ? `${row.code} · ${row.name}` : requireText("locations.name", row.name),
  });
  return rows.slice(0, limit + (pinned ? 1 : 0)).map(toOption);
}

/**
 * Public boundary: one tenant-scoped transaction, the authoritative HRM
 * feature gate rechecked inside it, then the scoped location options.
 * Read only.
 */
export async function listLocationOptions(query: LocationOptionsQuery): Promise<readonly LocationOptionDTO[]> {
  const orgId = requireId("orgId", query.orgId);
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    return loadLocationOptions(db, query);
  });
}

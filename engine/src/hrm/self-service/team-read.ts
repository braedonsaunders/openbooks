import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import { businessToday } from "../../platform/business-date.ts";
import { lockAndCheckOrgFeature } from "../../organization/org-feature-lock.ts";
import { loadOwnEmploymentIds, requireHrmSelfRead } from "../authorization.ts";
import { actorPartyOf, SelfServiceError } from "./actor.ts";
import { loadMyEmploymentSummaries, type MyEmploymentSummary } from "./self-read.ts";

/**
 * Manager team reads (HR-9): exactly the actor's direct reports, one level.
 *
 * Authority is STRUCTURAL, resolved here and never by a role grant: a row
 * qualifies when a currently-asserted LINE reporting relationship (live
 * recorded row whose effective window contains business today — the same
 * predicate payroll-context.ts routes manager notifications by) names one
 * of the actor's own employments as the manager. No transitive walk in v1:
 * a report's report is not visible, stated plainly and tested.
 *
 * A manager with no direct reports as of today is refused by name
 * (NO_TEAM), never shown an empty team pretending they manage nobody —
 * and the Team tab itself renders only when the actor holds reports.
 */

async function assertHrmFeatureOn(exec: SqlExecutor, orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(exec, orgId, "hrm"))) {
    throw new SelfServiceError(
      "FORBIDDEN",
      "hrm feature is disabled: enable it on Company Settings → Features before using self-service",
    );
  }
}

function requireOrgId(orgId: unknown): string {
  if (typeof orgId !== "string" || orgId.length === 0) {
    throw new SelfServiceError("REFUSED", "orgId must be a non-empty string");
  }
  return orgId;
}

function requireActorId(actorId: unknown): string {
  if (typeof actorId !== "string" || actorId.length === 0) {
    throw new SelfServiceError("REFUSED", "actorId must be a non-empty string");
  }
  return actorId;
}

/**
 * The actor's direct-report employment ids as of today. One level: rows
 * whose live line relationship names an employment of the actor's party
 * as manager. Matrix (dotted-line) edges never confer team visibility.
 */
export async function resolveTeamEmploymentIds(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  today: string,
): Promise<string[]> {
  const partyId = await actorPartyOf(exec, orgId, actorId);
  const own = await loadOwnEmploymentIds(exec, orgId, actorId);
  if (own.length === 0) return [];
  const rows = (await exec.execute<{ id: string }>(sql`
    select distinct r.employment_id::text as id
      from reporting_relationships r
     where r.org_id = ${orgId}
       and r.manager_employment_id in (select jsonb_array_elements_text(${JSON.stringify(own)}::jsonb)::uuid)
       and r.kind = 'line'
       and r.recorded_until is null
       and r.effective_from <= ${today}::date
       and (r.effective_to is null or r.effective_to > ${today}::date)
     order by id
  `)).rows;
  // The party proves personhood for the no-link refusal above; the ids
  // prove structure. A linked person who manages nobody holds no team.
  void partyId;
  return rows.map((row) => row.id);
}

/**
 * Whether the actor holds direct reports as of today — the Team tab's
 * render gate. False is a fact, never a refusal: the tab hides.
 */
export async function actorHasTeam(query: {
  readonly orgId: string;
  readonly actorId: string;
}): Promise<boolean> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    await requireHrmSelfRead(db, orgId, actorId);
    const today = await businessToday(orgId);
    const reports = await resolveTeamEmploymentIds(db, orgId, actorId, today);
    return reports.length > 0;
  });
}

export interface TeamRosterEntry extends MyEmploymentSummary {
  readonly workerPartyId: string;
  readonly workerName: string;
}

/**
 * The direct-report roster with the same as-of summaries as the person's
 * own profile — title, department, employer, status, service start — plus
 * the worker identity the rows belong to. Payroll, wages, and compliance
 * are never selected here, so they cannot leak through this read no
 * matter which drawer tab renders the rows.
 */
export async function loadTeamRoster(
  exec: SqlExecutor,
  orgId: string,
  reportIds: readonly string[],
  today: string,
): Promise<TeamRosterEntry[]> {
  if (reportIds.length === 0) return [];
  const summaries = await loadMyEmploymentSummaries(exec, orgId, reportIds, today);
  const names = (await exec.execute<{ employment_id: string; worker_party_id: string; name: string }>(sql`
    select e.id::text as employment_id,
           e.worker_party_id::text as worker_party_id,
           p.display_name as name
      from worker_employments e
      join parties p on p.org_id = e.org_id and p.id = e.worker_party_id
     where e.org_id = ${orgId}
       and e.id in (select jsonb_array_elements_text(${JSON.stringify([...reportIds])}::jsonb)::uuid)
  `)).rows;
  const byId = new Map(names.map((row) => [row.employment_id, row]));
  return summaries.map((summary) => {
    const identity = byId.get(summary.employmentId);
    if (!identity) {
      throw new SelfServiceError(
        "NOT_FOUND",
        "a direct report's employment is not visible in this organization — reload the team",
      );
    }
    return { ...summary, workerPartyId: identity.worker_party_id, workerName: identity.name };
  });
}

export interface TeamStep {
  readonly id: string;
  readonly processId: string;
  readonly processKind: string;
  readonly employmentId: string;
  readonly workerName: string;
  readonly title: string;
  readonly dueOn: string;
  readonly required: boolean;
  readonly evidenceKind: string;
  readonly ownerKind: string;
  readonly overdue: boolean;
}

/**
 * Open steps on reports' processes assigned to the manager: manager-owned
 * steps on those processes plus steps naming the manager directly. HR-owned
 * and employee-owned steps are never the manager's to work — they stay
 * listed nowhere here.
 */
export async function loadTeamSteps(
  exec: SqlExecutor,
  orgId: string,
  partyId: string,
  reportIds: readonly string[],
  today: string,
): Promise<TeamStep[]> {
  if (reportIds.length === 0) return [];
  const rows = (await exec.execute<{
    id: string;
    process_id: string;
    process_kind: string;
    employment_id: string;
    worker_name: string;
    title: string;
    due_on: string;
    required: boolean;
    evidence_kind: string;
    owner_kind: string;
  }>(sql`
    select s.id, s.process_id::text as process_id, p.kind as process_kind,
           p.employment_id::text as employment_id,
           wp.display_name as worker_name,
           s.title, s.due_on::text as due_on,
           s.required, s.evidence_kind, s.owner_kind
      from hrm_process_steps s
      join hrm_processes p on p.org_id = s.org_id and p.id = s.process_id
      join worker_employments e on e.org_id = s.org_id and e.id = p.employment_id
      join parties wp on wp.org_id = s.org_id and wp.id = e.worker_party_id
     where s.org_id = ${orgId}
       and s.status = 'pending'
       and p.status = 'open'
       and p.employment_id in (select jsonb_array_elements_text(${JSON.stringify([...reportIds])}::jsonb)::uuid)
       and (
         s.owner_kind = 'manager'
         or (s.owner_kind = 'named_party' and s.owner_party_id = ${partyId}::uuid)
       )
     order by s.due_on, s.id
  `)).rows;
  return rows.map((row) => ({
    id: row.id,
    processId: row.process_id,
    processKind: row.process_kind,
    employmentId: row.employment_id,
    workerName: row.worker_name,
    title: row.title,
    dueOn: row.due_on,
    required: row.required,
    evidenceKind: row.evidence_kind,
    ownerKind: row.owner_kind,
    overdue: row.due_on < today,
  }));
}

export interface TeamLeaveRequest {
  readonly id: string;
  readonly employmentId: string;
  readonly workerName: string;
  readonly leaveTypeCode: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly hours: string;
  readonly status: string;
  readonly reason: string | null;
}

/**
 * Reports' leave requests awaiting a decision (submitted only): the
 * approve/decline itself rides the existing native Approvals worklist —
 * this read deep-links there and builds no second decision path.
 */
export async function loadTeamLeaveRequests(
  exec: SqlExecutor,
  orgId: string,
  reportIds: readonly string[],
): Promise<TeamLeaveRequest[]> {
  if (reportIds.length === 0) return [];
  const rows = (await exec.execute<{
    id: string;
    employment_id: string;
    worker_name: string;
    leave_type_code: string;
    starts_on: string;
    ends_on: string;
    hours: string;
    status: string;
    reason: string | null;
  }>(sql`
    select r.id, r.employment_id::text as employment_id,
           wp.display_name as worker_name,
           t.code as leave_type_code,
           r.starts_on::text as starts_on, r.ends_on::text as ends_on,
           r.hours::text as hours, r.status, r.reason
      from hrm_leave_requests r
      join hrm_leave_types t on t.id = r.leave_type_id and t.org_id = r.org_id
      join worker_employments e on e.id = r.employment_id and e.org_id = r.org_id
      join parties wp on wp.org_id = r.org_id and wp.id = e.worker_party_id
     where r.org_id = ${orgId}
       and r.employment_id in (select jsonb_array_elements_text(${JSON.stringify([...reportIds])}::jsonb)::uuid)
       and r.status = 'submitted'
     order by r.starts_on, r.id
  `)).rows;
  return rows.map((row) => ({
    id: row.id,
    employmentId: row.employment_id,
    workerName: row.worker_name,
    leaveTypeCode: row.leave_type_code,
    startsOn: row.starts_on.slice(0, 10),
    endsOn: row.ends_on.slice(0, 10),
    hours: row.hours,
    status: row.status,
    reason: row.reason,
  }));
}

export interface TeamChangeRequest {
  readonly id: string;
  readonly employmentId: string;
  readonly workerName: string;
  readonly kind: string;
  readonly status: string;
  readonly submittedAt: string | null;
}

/**
 * Reports' change requests awaiting a decision. Like leave, the decision
 * rides native Flows — this read names the rows, never decides them.
 */
export async function loadTeamChangeRequests(
  exec: SqlExecutor,
  orgId: string,
  reportIds: readonly string[],
): Promise<TeamChangeRequest[]> {
  if (reportIds.length === 0) return [];
  const rows = (await exec.execute<{
    id: string;
    employment_id: string;
    worker_name: string;
    payload: { kind?: unknown };
    status: string;
    submitted_at: string | null;
  }>(sql`
    select r.id, r.employment_id::text as employment_id,
           wp.display_name as worker_name,
           r.payload, r.status, r.submitted_at::text as submitted_at
      from hrm_employment_change_requests r
      join worker_employments e on e.id = r.employment_id and e.org_id = r.org_id
      join parties wp on wp.org_id = r.org_id and wp.id = e.worker_party_id
     where r.org_id = ${orgId}
       and r.employment_id in (select jsonb_array_elements_text(${JSON.stringify([...reportIds])}::jsonb)::uuid)
       and r.status = 'pending_approval'
     order by r.submitted_at, r.id
  `)).rows;
  return rows.map((row) => ({
    id: row.id,
    employmentId: row.employment_id,
    workerName: row.worker_name,
    kind: typeof row.payload?.kind === "string" ? row.payload.kind : "unknown",
    status: row.status,
    submittedAt: row.submitted_at,
  }));
}

export interface TeamView {
  readonly asOf: string;
  readonly reports: readonly TeamRosterEntry[];
  readonly openSteps: readonly TeamStep[];
  readonly pendingLeave: readonly TeamLeaveRequest[];
  readonly pendingChanges: readonly TeamChangeRequest[];
}

/**
 * Public boundary: the manager's team as of today. Structural all the
 * way down — a report-less actor is refused by name, never shown an
 * empty team.
 */
export async function getTeamView(query: {
  readonly orgId: string;
  readonly actorId: string;
}): Promise<TeamView> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    await requireHrmSelfRead(db, orgId, actorId);
    const partyId = await actorPartyOf(db, orgId, actorId);
    const today = await businessToday(orgId);
    const reports = await resolveTeamEmploymentIds(db, orgId, actorId, today);
    if (reports.length === 0) {
      throw new SelfServiceError(
        "NO_TEAM",
        `no direct reports as of ${today} — team visibility follows the current line reporting relationship; ask HR to record the reporting line before opening the team view`,
      );
    }
    return {
      asOf: today,
      reports: await loadTeamRoster(db, orgId, reports, today),
      openSteps: await loadTeamSteps(db, orgId, partyId, reports, today),
      pendingLeave: await loadTeamLeaveRequests(db, orgId, reports),
      pendingChanges: await loadTeamChangeRequests(db, orgId, reports),
    };
  });
}

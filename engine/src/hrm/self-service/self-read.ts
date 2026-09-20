import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import { businessToday } from "../../platform/business-date.ts";
import { lockAndCheckOrgFeature } from "../../organization/org-feature-lock.ts";
import { loadOwnEmploymentIds, requireHrmSelfRead } from "../authorization.ts";
import { actorPartyOf, SelfServiceError } from "./actor.ts";

/**
 * Self-service reads (HR-9): the person's own rows, nothing else.
 *
 * Scope is structural, enforced here in the engine and never in a page:
 * every function resolves the actor's party through actorPartyOf on the
 * trusted runner and predicates every row on it (own employment ids, own
 * party, owned steps). There is no employment, party, or step parameter
 * to forge — a second person's rows can never be returned because they
 * can never be named.
 *
 * The hrm feature gate is rechecked inside each public transaction like
 * every other HRM read boundary; loaders stay gate-free so one
 * transaction pays for one check.
 */

export const HRM_FEATURE_KEY = "hrm" as const;

async function assertHrmFeatureOn(exec: SqlExecutor, orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(exec, orgId, HRM_FEATURE_KEY))) {
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

// --- Profile ---------------------------------------------------------------

export interface MyAddress {
  readonly id: string;
  readonly label: string | null;
  readonly line1: string | null;
  readonly line2: string | null;
  readonly city: string | null;
  readonly region: string | null;
  readonly postalCode: string | null;
  readonly country: string | null;
}

export interface MyEmergencyContact {
  readonly name: string | null;
  readonly relationship: string | null;
  readonly phone: string | null;
}

export interface MyEmploymentSummary {
  readonly employmentId: string;
  readonly status: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly jobTitle: string | null;
  readonly departmentId: string | null;
  readonly departmentName: string | null;
  readonly employerSubsidiaryId: string;
  readonly employerName: string;
  /** Earliest effective_from across recorded versions: when service started. */
  readonly serviceStart: string;
  readonly managerNames: readonly string[];
}

export interface MyProfile {
  readonly partyId: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly emergencyContact: MyEmergencyContact | null;
  readonly address: MyAddress | null;
  readonly employments: readonly MyEmploymentSummary[];
}

type PartyRow = {
  id: string;
  display_name: string;
  email: string | null;
  phone: string | null;
  emergency_contact: MyEmergencyContact | null;
};

/**
 * The actor's party row with its editable contact fields. Zero rows is a
 * failure, not an empty profile: the party behind the login must exist.
 */
export async function loadMyParty(
  exec: SqlExecutor,
  orgId: string,
  partyId: string,
): Promise<PartyRow> {
  const row = (await exec.execute<PartyRow>(sql`
    select id, display_name, email, phone,
           emergency_contact as "emergency_contact"
      from parties
     where org_id = ${orgId} and id = ${partyId}
  `)).rows[0];
  if (!row) {
    throw new SelfServiceError(
      "NOT_FOUND",
      "the person linked to this login has no party record in this organization — ask an administrator to repair the person link in Admin → Users",
    );
  }
  return row;
}

/**
 * The actor's postal address: the default billing address when one is
 * marked, else the most recently updated — one row, deterministically
 * picked, so the profile never shows a silently chosen address.
 */
export async function loadMyAddress(
  exec: SqlExecutor,
  orgId: string,
  partyId: string,
): Promise<MyAddress | null> {
  const row = (await exec.execute<{
    id: string;
    label: string | null;
    line1: string | null;
    line2: string | null;
    city: string | null;
    region: string | null;
    postal_code: string | null;
    country: string | null;
  }>(sql`
    select id, label, line1, line2, city, region, postal_code, country
      from addresses
     where org_id = ${orgId} and party_id = ${partyId}
     order by is_default_billing desc, updated_at desc, id
     limit 1
  `)).rows[0];
  if (!row) return null;
  return {
    id: row.id,
    label: row.label,
    line1: row.line1,
    line2: row.line2,
    city: row.city,
    region: row.region,
    postalCode: row.postal_code,
    country: row.country,
  };
}

type EmploymentSummaryRow = {
  employment_id: string;
  status: string;
  effective_from: string;
  effective_to: string | null;
  job_title: string | null;
  department_id: string | null;
  department_name: string | null;
  employer_subsidiary_id: string;
  employer_name: string;
  service_start: string;
};

/**
 * One summary row per own employment: the live version covering today when
 * one exists (in service now), else the live version with the latest start
 * (a future hire shows its offer; a finished employment its last episode).
 * The primary assignment and the manager line resolve at the same as-of
 * point, so title, department, and manager can never mix episodes.
 */
export async function loadMyEmploymentSummaries(
  exec: SqlExecutor,
  orgId: string,
  employmentIds: readonly string[],
  today: string,
): Promise<MyEmploymentSummary[]> {
  if (employmentIds.length === 0) return [];
  // Bare JS arrays interpolate as row constructors, never PostgreSQL
  // arrays: ids cross as a JSON string, exactly like the sibling reads.
  const rows = (await exec.execute<EmploymentSummaryRow>(sql`
    with ranked as (
      select e.id as employment_id,
             v.status, v.effective_from::text as effective_from,
             v.effective_to::text as effective_to,
             e.employer_subsidiary_id::text as employer_subsidiary_id,
             s.name as employer_name,
             row_number() over (
               partition by e.id
               order by ((v.effective_from <= ${today}::date
                          and (v.effective_to is null or v.effective_to > ${today}::date))::int) desc,
                        v.effective_from desc, v.version_no desc
             ) as rn
        from worker_employments e
        join worker_employment_versions v
          on v.org_id = e.org_id and v.employment_id = e.id
         and v.recorded_until is null
        join subsidiaries s
          on s.org_id = e.org_id and s.id = e.employer_subsidiary_id
       where e.org_id = ${orgId}
         and e.id in (select jsonb_array_elements_text(${JSON.stringify([...employmentIds])}::jsonb)::uuid)
    )
    select r.employment_id, r.status, r.effective_from, r.effective_to,
           pa.job_title, pa.department_id::text as department_id,
           d.name as department_name,
           r.employer_subsidiary_id, r.employer_name,
           (select min(v2.effective_from)::text
              from worker_employment_versions v2
             where v2.org_id = ${orgId} and v2.employment_id = r.employment_id) as service_start
      from ranked r
      left join lateral (
        select av.job_title, av.department_id
          from employment_assignment_versions av
         where av.org_id = ${orgId}
           and av.employment_id = r.employment_id
           and av.recorded_until is null
           and av.is_primary
           and av.effective_from <= ${today}::date
           and (av.effective_to is null or av.effective_to > ${today}::date)
         order by av.version_no desc
         limit 1
      ) pa on true
      left join departments d
        on d.org_id = ${orgId} and d.id = pa.department_id
     where r.rn = 1
     order by r.employment_id
  `)).rows;
  const summaries: MyEmploymentSummary[] = [];
  for (const row of rows) {
    const managers = (await exec.execute<{ name: string }>(sql`
      select distinct p.display_name as name
        from reporting_relationships r
        join worker_employments m
          on m.org_id = r.org_id and m.id = r.manager_employment_id
        join parties p
          on p.org_id = r.org_id and p.id = m.worker_party_id
       where r.org_id = ${orgId}
         and r.employment_id = ${row.employment_id}::uuid
         and r.kind = 'line'
         and r.recorded_until is null
         and r.effective_from <= ${today}::date
         and (r.effective_to is null or r.effective_to > ${today}::date)
       order by p.display_name
    `)).rows.map((manager) => manager.name);
    summaries.push({
      employmentId: row.employment_id,
      status: row.status,
      effectiveFrom: row.effective_from,
      effectiveTo: row.effective_to,
      jobTitle: row.job_title,
      departmentId: row.department_id,
      departmentName: row.department_name,
      employerSubsidiaryId: row.employer_subsidiary_id,
      employerName: row.employer_name,
      serviceStart: row.service_start,
      managerNames: managers,
    });
  }
  return summaries;
}

/** Public boundary: the actor's own profile. Read-only, one transaction. */
export async function getMyProfile(query: {
  readonly orgId: string;
  readonly actorId: string;
}): Promise<MyProfile> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    await requireHrmSelfRead(db, orgId, actorId);
    const partyId = await actorPartyOf(db, orgId, actorId);
    const party = await loadMyParty(db, orgId, partyId);
    const address = await loadMyAddress(db, orgId, partyId);
    const own = await loadOwnEmploymentIds(db, orgId, actorId);
    const today = await businessToday(orgId);
    const employments = await loadMyEmploymentSummaries(db, orgId, own, today);
    const emergency = party.emergency_contact;
    return {
      partyId: party.id,
      displayName: party.display_name,
      email: party.email,
      phone: party.phone,
      emergencyContact:
        emergency === null || typeof emergency !== "object"
          ? null
          : {
              name: typeof emergency.name === "string" ? emergency.name : null,
              relationship:
                typeof emergency.relationship === "string" ? emergency.relationship : null,
              phone: typeof emergency.phone === "string" ? emergency.phone : null,
            },
      address,
      employments,
    };
  });
}

// --- Own steps ---------------------------------------------------------------

export interface MyStep {
  readonly id: string;
  readonly processId: string;
  readonly processKind: string;
  readonly employmentId: string;
  readonly title: string;
  readonly description: string | null;
  readonly dueOn: string;
  readonly required: boolean;
  readonly evidenceKind: string;
  readonly overdue: boolean;
}

/**
 * The actor's own open steps: employee-owned steps on their employments
 * plus steps naming them directly — the checklists surface lists through
 * this, and completion rides the existing step endpoint whose ownership
 * check agrees step for step.
 */
export async function loadMySteps(
  exec: SqlExecutor,
  orgId: string,
  partyId: string,
  employmentIds: readonly string[],
  today: string,
): Promise<MyStep[]> {
  if (employmentIds.length === 0) return [];
  const rows = (await exec.execute<{
    id: string;
    process_id: string;
    process_kind: string;
    employment_id: string;
    title: string;
    description: string | null;
    due_on: string;
    required: boolean;
    evidence_kind: string;
  }>(sql`
    select s.id, s.process_id::text as process_id, p.kind as process_kind,
           p.employment_id::text as employment_id,
           s.title, s.description, s.due_on::text as due_on,
           s.required, s.evidence_kind
      from hrm_process_steps s
      join hrm_processes p on p.org_id = s.org_id and p.id = s.process_id
     where s.org_id = ${orgId}
       and s.status = 'pending'
       and p.status = 'open'
       and (
         (
           p.employment_id in (select jsonb_array_elements_text(${JSON.stringify([...employmentIds])}::jsonb)::uuid)
           and s.owner_kind = 'employee'
         )
         or (s.owner_kind = 'named_party' and s.owner_party_id = ${partyId}::uuid)
       )
     order by s.due_on, s.id
  `)).rows;
  return rows.map((row) => ({
    id: row.id,
    processId: row.process_id,
    processKind: row.process_kind,
    employmentId: row.employment_id,
    title: row.title,
    description: row.description,
    dueOn: row.due_on,
    required: row.required,
    evidenceKind: row.evidence_kind,
    overdue: row.due_on < today,
  }));
}

/** Public boundary: the actor's own open steps. Read-only. */
export async function getMySteps(query: {
  readonly orgId: string;
  readonly actorId: string;
}): Promise<MyStep[]> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    await requireHrmSelfRead(db, orgId, actorId);
    const partyId = await actorPartyOf(db, orgId, actorId);
    const own = await loadOwnEmploymentIds(db, orgId, actorId);
    const today = await businessToday(orgId);
    return loadMySteps(db, orgId, partyId, own, today);
  });
}

// --- Own requests ------------------------------------------------------------

export interface MyRequest {
  readonly id: string;
  readonly employmentId: string;
  readonly kind: string;
  readonly status: string;
  readonly reason: string | null;
  readonly submittedAt: string | null;
  readonly createdAt: string;
}

/**
 * The actor's own change requests (profile, leave-adjacent employment
 * proposals they filed) newest first — the overview's pending panel.
 * Scoped by own employment ids, never by a caller-supplied filter.
 */
export async function loadMyRequests(
  exec: SqlExecutor,
  orgId: string,
  employmentIds: readonly string[],
): Promise<MyRequest[]> {
  if (employmentIds.length === 0) return [];
  const rows = (await exec.execute<{
    id: string;
    employment_id: string;
    payload: { kind?: unknown };
    status: string;
    reason: string | null;
    submitted_at: string | null;
    created_at: string;
  }>(sql`
    select id, employment_id::text as employment_id, payload, status, reason,
           submitted_at::text as submitted_at, created_at::text as created_at
      from hrm_employment_change_requests
     where org_id = ${orgId}
       and employment_id in (select jsonb_array_elements_text(${JSON.stringify([...employmentIds])}::jsonb)::uuid)
     order by created_at desc, id desc
     limit 100
  `)).rows;
  return rows.map((row) => ({
    id: row.id,
    employmentId: row.employment_id,
    kind: typeof row.payload?.kind === "string" ? row.payload.kind : "unknown",
    status: row.status,
    reason: row.reason,
    submittedAt: row.submitted_at,
    createdAt: row.created_at,
  }));
}

/** Public boundary: the actor's own change requests. Read-only. */
export async function getMyRequests(query: {
  readonly orgId: string;
  readonly actorId: string;
}): Promise<MyRequest[]> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    await requireHrmSelfRead(db, orgId, actorId);
    await actorPartyOf(db, orgId, actorId);
    const own = await loadOwnEmploymentIds(db, orgId, actorId);
    return loadMyRequests(db, orgId, own);
  });
}

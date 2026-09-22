/**
 * HR-20 field-time reads: own clock status, today's pairs, crew-today,
 * batch lists, and approver flags.
 *
 * The actor resolves to a party through users.party_id on the trusted
 * runner — client input never names whose time is read. Raw coordinates
 * never leave this module except through the coordinates report entity
 * (hrm.employment.read) and the approval drawer (time.approve).
 */

import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../../platform/db.ts";
import { lockAndCheckOrgFeature } from "../../organization/org-feature-lock.ts";
import { FieldTimeError, refuse } from "./errors.ts";
import { FIELD_TIME_CREW_ENTRY_FEATURE, FIELD_TIME_FEATURE } from "./settings.ts";
import { clockStatus } from "./clock.ts";

export async function resolveOwnParty(orgId: string, userId: string, exec: SqlExecutor = db): Promise<string> {
  const row = (await exec.execute<{ party_id: string | null }>(sql`
    select party_id::text as party_id from users where org_id = ${orgId} and id = ${userId}`)).rows[0];
  if (!row?.party_id) {
    refuse(
      "no_employee_link",
      "No employee record is linked to this login — ask HR to link the user to an employee party before clocking in",
    );
  }
  return row.party_id!;
}

export type TodayPair = {
  pairId: string;
  clockInAt: string;
  clockOutAt: string | null;
  projectId: string | null;
  projectName: string | null;
  costCodeRef: string | null;
  entryHours: string | null;
  geoCheck: string;
  autoClosed: boolean;
  hasPhoto: boolean;
}

export async function myClockDay(orgId: string, userId: string, exec: SqlExecutor = db): Promise<{
  status: Awaited<ReturnType<typeof clockStatus>>;
  pairs: TodayPair[];
}> {
  if (!(await lockAndCheckOrgFeature(exec, orgId, FIELD_TIME_FEATURE))) {
    refuse(
      "field_time_off",
      "Field time is turned off — turn on fieldTime in Company Settings → Features to clock in from the field",
    );
  }
  const partyId = await resolveOwnParty(orgId, userId, exec);
  const status = await clockStatus(orgId, partyId);
  const pairs = (await exec.execute<TodayPair>(sql`
    select i.id::text as "pairId", i.occurred_at::text as "clockInAt",
           o.occurred_at::text as "clockOutAt",
           i.project_id::text as "projectId", p.name as "projectName",
           i.cost_code_ref as "costCodeRef",
           (select sum(te.hours)::text from time_entries te
             where te.org_id = i.org_id and te.clock_pair_id = i.id) as "entryHours",
           i.geo_check as "geoCheck", o.auto_closed as "autoClosed",
           (i.photo_file_id is not null or o.photo_file_id is not null) as "hasPhoto"
      from time_clock_events i
      left join time_clock_events o
        on o.org_id = i.org_id and o.pair_id = i.id and o.kind = 'clock_out'
      left join projects p on p.org_id = i.org_id and p.id = i.project_id
     where i.org_id = ${orgId} and i.employee_party_id = ${partyId}
       and i.kind = 'clock_in'
       and i.occurred_at >= date_trunc('day', now())
     order by i.occurred_at desc`)).rows;
  return { status, pairs };
}

/**
 * The manager's direct reports clocked in now — structural team scope
 * (line reports as of today), never role grant. Empty team reads as an
 * empty list, never an error.
 */
export async function teamClockedIn(orgId: string, userId: string, today: string, exec: SqlExecutor = db): Promise<Array<{
  employeePartyId: string;
  employeeName: string | null;
  since: string;
  projectName: string | null;
  costCodeRef: string | null;
  geoCheck: string;
}>> {
  // Gate first: with the feature off even the employment/team lookups below
  // must not run — an existing path calling this must observe nothing.
  if (!(await lockAndCheckOrgFeature(exec, orgId, FIELD_TIME_FEATURE))) return [];
  const person = (await exec.execute<{ party_id: string | null }>(sql`
    select party_id::text as party_id from users where org_id = ${orgId} and id = ${userId}`)).rows[0];
  if (!person?.party_id) return [];
  const own = (await exec.execute<{ id: string }>(sql`
    select id::text as id from worker_employments
     where org_id = ${orgId} and worker_party_id = ${person.party_id}`)).rows.map((row) => row.id);
  if (own.length === 0) return [];
  // One parameter per id: bare JS arrays must never be interpolated into
  // ANY() (they bind as row constructors, not PostgreSQL arrays).
  const ids = own.map((id) => sql`${id}::uuid`);
  return (await exec.execute<{
    employeePartyId: string;
    employeeName: string | null;
    since: string;
    projectName: string | null;
    costCodeRef: string | null;
    geoCheck: string;
  }>(sql`
    select e.worker_party_id::text as "employeePartyId",
           emp.display_name as "employeeName",
           i.occurred_at::text as since,
           prj.name as "projectName",
           i.cost_code_ref as "costCodeRef", i.geo_check as "geoCheck"
      from reporting_relationships r
      join worker_employments e
        on e.org_id = r.org_id and e.id = r.employment_id
      join time_clock_events i
        on i.org_id = r.org_id and i.employee_party_id = e.worker_party_id
       and i.kind = 'clock_in' and i.status = 'recorded'
      left join parties emp on emp.id = e.worker_party_id and emp.org_id = r.org_id
      left join projects prj on prj.id = i.project_id and prj.org_id = r.org_id
     where r.org_id = ${orgId}
       and r.manager_employment_id in (${sql.join(ids, sql`, `)})
       and r.kind = 'line'
       and r.recorded_until is null
       and r.effective_from <= ${today}::date
       and (r.effective_to is null or r.effective_to > ${today}::date)
     order by i.occurred_at`)).rows;
}

/** Who is clocked in on a project right now — the cockpit "Crew today". */
export async function crewToday(orgId: string, projectId: string, exec: SqlExecutor = db): Promise<Array<{
  employeePartyId: string;
  employeeName: string | null;
  since: string;
  costCodeRef: string | null;
  geoCheck: string;
}>> {
  if (!(await lockAndCheckOrgFeature(exec, orgId, FIELD_TIME_FEATURE))) return [];
  return (await exec.execute<{
    employeePartyId: string;
    employeeName: string | null;
    since: string;
    costCodeRef: string | null;
    geoCheck: string;
  }>(sql`
    select i.employee_party_id::text as "employeePartyId",
           emp.display_name as "employeeName",
           i.occurred_at::text as since,
           i.cost_code_ref as "costCodeRef", i.geo_check as "geoCheck"
      from time_clock_events i
      join parties emp on emp.id = i.employee_party_id and emp.org_id = i.org_id
     where i.org_id = ${orgId} and i.kind = 'clock_in' and i.status = 'recorded'
       and (i.project_id = ${projectId} or ${projectId}::uuid is null)
     order by i.occurred_at`)).rows;
}

export type CrewBatchSummary = {
  id: string;
  foremanName: string | null;
  projectName: string | null;
  workedOn: string;
  status: string;
  totalHours: string;
  workerCount: number;
}

export async function listCrewBatches(
  orgId: string,
  filter: { status?: string | null; projectId?: string | null },
  exec: SqlExecutor = db,
): Promise<CrewBatchSummary[]> {
  if (!(await lockAndCheckOrgFeature(exec, orgId, FIELD_TIME_CREW_ENTRY_FEATURE))) {
    refuse(
      "field_time_crew_off",
      "Crew time entry is turned off — turn on fieldTimeCrewEntry in Company Settings → Features to see crew batches",
    );
  }
  return (await exec.execute<CrewBatchSummary>(sql`
    select b.id::text as id, frm.display_name as "foremanName",
           prj.name as "projectName", b.worked_on::text as "workedOn", b.status,
           coalesce(sum(l.hours), 0)::text as "totalHours",
           count(distinct l.employee_party_id)::int as "workerCount"
      from crew_time_batches b
      left join parties frm on frm.id = b.foreman_party_id and frm.org_id = b.org_id
      left join projects prj on prj.id = b.project_id and prj.org_id = b.org_id
      left join crew_time_batch_lines l on l.batch_id = b.id
     where b.org_id = ${orgId}
       ${filter.status ? sql`and b.status = ${filter.status}` : sql``}
       ${filter.projectId ? sql`and b.project_id = ${filter.projectId}` : sql``}
     group by b.id, frm.display_name, prj.name, b.worked_on, b.status
     order by b.worked_on desc, b.id`)).rows;
}

export type BatchDetail = {
  id: string;
  status: string;
  foremanPartyId: string;
  foremanName: string | null;
  projectId: string;
  projectName: string | null;
  workedOn: string;
  notes: string | null;
  signatureEvidence: unknown;
  lines: Array<{
    id: string;
    employeePartyId: string;
    employeeName: string | null;
    hours: string;
    timeTypeId: string | null;
    projectTaskId: string | null;
    costCodeRef: string | null;
    equipmentId: string | null;
    equipmentUnit: string | null;
    equipmentHours: string | null;
    memo: string | null;
  }>;
  events: Array<{ kind: string; actorName: string | null; reason: string | null; recordedAt: string }>;
}

export async function getBatchDetail(orgId: string, batchId: string, exec: SqlExecutor = db): Promise<BatchDetail> {
  if (!(await lockAndCheckOrgFeature(exec, orgId, FIELD_TIME_CREW_ENTRY_FEATURE))) {
    refuse(
      "field_time_crew_off",
      "Crew time entry is turned off — turn on fieldTimeCrewEntry in Company Settings → Features to see crew batches",
    );
  }
  const batch = (await exec.execute<{
    id: string; status: string; foreman_party_id: string; foreman_name: string | null;
    project_id: string; project_name: string | null; worked_on: string;
    notes: string | null; signature_evidence: unknown;
  }>(sql`
    select b.id::text as id, b.status, b.foreman_party_id::text as foreman_party_id,
           frm.display_name as foreman_name, b.project_id::text as project_id,
           prj.name as project_name, b.worked_on::text as worked_on,
           b.notes, b.signature_evidence
      from crew_time_batches b
      left join parties frm on frm.id = b.foreman_party_id and frm.org_id = b.org_id
      left join projects prj on prj.id = b.project_id and prj.org_id = b.org_id
     where b.org_id = ${orgId} and b.id = ${batchId}`)).rows[0];
  if (!batch) {
    throw new FieldTimeError("batch_unknown", "The crew batch is unknown in this organization — reload the crew list");
  }
  const lines = (await exec.execute<BatchDetail["lines"][number]>(sql`
    select l.id::text as id, l.employee_party_id::text as "employeePartyId",
           emp.display_name as "employeeName", l.hours::text as hours,
           l.time_type_id::text as "timeTypeId", l.project_task_id::text as "projectTaskId",
           l.cost_code_ref as "costCodeRef", l.equipment_id::text as "equipmentId",
           eq.unit_number as "equipmentUnit", l.equipment_hours::text as "equipmentHours",
           l.memo
      from crew_time_batch_lines l
      left join parties emp on emp.id = l.employee_party_id and emp.org_id = ${orgId}
      left join equipment_units eq on eq.id = l.equipment_id and eq.org_id = ${orgId}
     where l.batch_id = ${batchId}
     order by emp.display_name, l.id`)).rows;
  const events = (await exec.execute<BatchDetail["events"][number]>(sql`
    select e.kind, u.name as "actorName", e.reason,
           e.recorded_at::text as "recordedAt"
      from crew_time_batch_events e
      left join users u on u.id = e.actor_id
     where e.org_id = ${orgId} and e.batch_id = ${batchId}
     order by e.recorded_at`)).rows;
  return {
    id: batch.id,
    status: batch.status,
    foremanPartyId: batch.foreman_party_id,
    foremanName: batch.foreman_name,
    projectId: batch.project_id,
    projectName: batch.project_name,
    workedOn: batch.worked_on,
    notes: batch.notes,
    signatureEvidence: batch.signature_evidence,
    lines,
    events,
  };
}

/**
 * Approver flags for a timesheet week or batch: geo/photo/auto-close
 * chips and the pair photo. Coordinates stay out — the drawer shows
 * the flag and the thumbnail, never the raw fix.
 */
export async function approvalFlags(
  orgId: string,
  filter: { weekStart?: string; employeePartyId?: string; batchId?: string },
  exec: SqlExecutor = db,
): Promise<Array<{
  entryId: string;
  workedOn: string;
  hours: string;
  geoCheck: string | null;
  autoClosed: boolean;
  hasPhoto: boolean;
  photoFileId: string | null;
}>> {
  // Gate first: the timesheet drawer calls this for every week it opens —
  // with the feature off it must observe nothing, not even a flag query.
  if (!(await lockAndCheckOrgFeature(exec, orgId, FIELD_TIME_FEATURE))) return [];
  const pairFilter = filter.batchId
    ? sql`and te.crew_batch_line_id in (select id from crew_time_batch_lines where batch_id = ${filter.batchId})`
    : sql`and te.employee_party_id = ${filter.employeePartyId} and te.worked_on >= ${filter.weekStart}::date and te.worked_on <= ${filter.weekStart}::date + 6`;
  return (await exec.execute<{
    entryId: string;
    workedOn: string;
    hours: string;
    geoCheck: string | null;
    autoClosed: boolean;
    hasPhoto: boolean;
    photoFileId: string | null;
  }>(sql`
    select te.id::text as "entryId", te.worked_on::text as "workedOn",
           te.hours::text as hours,
           -- One entry joins every clock event of its pair, so geo_check must
           -- be aggregated like the flags beside it: the chip shows the
           -- worst status the week recorded (an outside punch must not be
           -- masked by an inside one), and a pair with no events stays NULL
           -- per the declared type. Ungrouped, this column made the whole
           -- query throw 42803 on every call.
           case
             when bool_or(ev.geo_check = 'outside') then 'outside'
             when bool_or(ev.geo_check = 'unavailable') then 'unavailable'
             when bool_or(ev.geo_check = 'inside') then 'inside'
             else max(ev.geo_check)
           end as "geoCheck",
           coalesce(bool_or(ev.auto_closed), false) as "autoClosed",
           coalesce(bool_or(ev.photo_file_id is not null), false) as "hasPhoto",
           max(ev.photo_file_id::text) as "photoFileId"
      from time_entries te
      left join time_clock_events ev
        on ev.org_id = te.org_id and ev.pair_id = te.clock_pair_id
     where te.org_id = ${orgId} ${pairFilter}
     group by te.id, te.worked_on, te.hours
     order by te.worked_on, te.id`)).rows;
}

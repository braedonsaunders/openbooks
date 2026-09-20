import "server-only";
import { sql, type SQL } from "drizzle-orm";
import type { ListViewConfig, FilterClause } from "@openbooks/customization";
import type { EntityAdhoc } from "./adhoc";
import { rolePartyWhere } from "./customers";
import { subsidiaryVisibleFilter } from "../../subsidiaries";
import { uuidOrFalse } from "../list-query";

/* ------------------------------------------------------------------ */
/* Employee directory (HR-2b)                                          */
/* ------------------------------------------------------------------ */

/**
 * Employment statuses readable as of today on the employee list. The
 * same five the HRM read service resolves through resolveAsOf — offered
 * has not commenced, suspended is interrupted, terminated has ended —
 * plus `no_employment` for parties holding no live employment row. The
 * registry's static quick-filter options name these same values; a new
 * status here must add its option there.
 */
export const EMPLOYMENT_STATUS_VALUES = [
  "offered",
  "active",
  "on_leave",
  "suspended",
  "terminated",
] as const;

/** Quick-filter value for parties with no live employment as of today. */
export const NO_EMPLOYMENT = "no_employment" as const;

/** Department quick-filter value for a live employment with no department. */
export const UNASSIGNED_DEPARTMENT = "unassigned" as const;

/** ListFilter/column keys the directory adds; dropped while HRM is off. */
export const EMPLOYEE_HRM_FILTER_KEYS = ["department", "employment_status", "employer"] as const;

/**
 * The ONE shared as-of predicate every directory column and filter reads.
 *
 * Mirrors the read service's own as-of rule (engine/src/hrm/temporal.ts
 * resolveAsOf: a revision applies when its recorded window covers asKnown
 * AND its effective interval covers the date) at asKnown = now: the live
 * version is the one still current (`recorded_until is null`), covering
 * today half-open (`effective_from <= today < effective_to`, null end
 * unbounded). employment-directory.test.ts pins this text against the
 * temporal source so the two cannot drift.
 */
export function liveVersionAsOf(alias: string, today: string): SQL {
  const version = sql.raw(alias);
  return sql`${version}.recorded_until is null and ${version}.effective_from <= ${today}::date and ${today}::date < coalesce(${version}.effective_to, 'infinity'::date)`;
}

/**
 * Directory employment joins for the employee list. One lateral row per
 * party at most: the live-as-of-today employment (lowest id wins when a
 * party holds several — multiples are the caller's ambiguity to refuse
 * in the read service, and the list stays total and stable instead of
 * fanning out), its live primary assignment only, and the department /
 * subsidiary name legs. Exposes:
 *   emp.employment_status, emp.job_title, emp.department_id,
 *   emp.employer_subsidiary_id, emp.service_start,
 *   emp_dept.name, emp_sub.name
 *
 * service_start is the directory employment's earliest effective_from
 * across every recorded version, superseded or not: start of service,
 * not start of the current episode.
 *
 * The lateral additionally fences employments to the viewer's allowed
 * employer subsidiaries: a party whose only employment sits outside the
 * actor's scope reads as no_employment here, exactly as
 * loadEmploymentsByParty filters it rather than returning it. Null
 * employers are invisible (the read service refuses such subjects).
 * HRM off returns no joins — predicates naming emp.* then fail closed
 * in the where builder, and no column can select what FROM never made.
 */
export function employeeBaseJoins(
  hrmOn: boolean,
  today: string,
  allowedSubsidiaryIds?: ReadonlySet<string> | null,
): SQL {
  if (!hrmOn) return sql``;
  return sql`
  left join lateral (
    select ev.status as employment_status,
           e.employer_subsidiary_id as employer_subsidiary_id,
           (select av.job_title
              from employment_assignment_versions av
              join employment_assignments a
                on a.id = av.assignment_id and a.org_id = av.org_id
             where av.org_id = e.org_id and av.employment_id = e.id
               and av.is_primary and ${liveVersionAsOf("av", today)}
             order by av.assignment_id, av.version_no desc
             limit 1) as job_title,
           (select av.department_id
              from employment_assignment_versions av
              join employment_assignments a
                on a.id = av.assignment_id and a.org_id = av.org_id
             where av.org_id = e.org_id and av.employment_id = e.id
               and av.is_primary and ${liveVersionAsOf("av", today)}
             order by av.assignment_id, av.version_no desc
             limit 1) as department_id,
           (select min(ev2.effective_from)::text
              from worker_employment_versions ev2
             where ev2.org_id = e.org_id and ev2.employment_id = e.id) as service_start
      from worker_employments e
      join worker_employment_versions ev
        on ev.org_id = e.org_id and ev.employment_id = e.id and ${liveVersionAsOf("ev", today)}
     where e.org_id = p.org_id and e.worker_party_id = p.id
       and e.employer_subsidiary_id is not null
       ${subsidiaryVisibleFilter(sql`e.employer_subsidiary_id`, allowedSubsidiaryIds ?? null)}
     order by e.id
     limit 1
  ) emp on true
  left join departments emp_dept on emp_dept.org_id = p.org_id and emp_dept.id = emp.department_id
  left join subsidiaries emp_sub on emp_sub.org_id = p.org_id and emp_sub.id = emp.employer_subsidiary_id`;
}

function departmentValues(values: string[]): { uuids: string[]; unassigned: boolean } {
  const uuids: string[] = [];
  let unassigned = false;
  for (const value of values) {
    if (value === UNASSIGNED_DEPARTMENT) unassigned = true;
    else uuids.push(value);
  }
  return { uuids, unassigned };
}

/**
 * Positive department match: a live employment whose primary assignment
 * sits in one of the uuids, or — when `unassigned` is named — a live
 * employment whose primary assignment carries no department. Parties
 * with no live employment never match: they are no_employment, not
 * unassigned, and the departments board Unassigned row counts only
 * employments in service.
 */
function departmentMatch(values: string[]): SQL | null {
  const { uuids, unassigned } = departmentValues(values);
  for (const uuid of uuids) {
    const refused = uuidOrFalse(uuid);
    if (refused) return refused;
  }
  const parts: SQL[] = [];
  if (uuids.length > 0) {
    const list = sql.join(uuids.map((uuid) => sql`${uuid}`), sql`, `);
    parts.push(sql`emp.department_id in (${list})`);
  }
  if (unassigned) {
    parts.push(sql`(emp.employment_status is not null and emp.department_id is null)`);
  }
  if (parts.length === 0) return null;
  return parts.length === 1 ? parts[0]! : sql`(${sql.join(parts, sql` or `)})`;
}

function employmentStatusMatch(values: string[]): SQL | null {
  const known = new Set<string>(EMPLOYMENT_STATUS_VALUES);
  const statuses: string[] = [];
  let noEmployment = false;
  for (const value of values) {
    if (value === NO_EMPLOYMENT) noEmployment = true;
    else if (known.has(value)) statuses.push(value);
    else return sql`false`;
  }
  const parts: SQL[] = [];
  if (statuses.length > 0) {
    const list = sql.join(statuses.map((status) => sql`${status}`), sql`, `);
    parts.push(sql`emp.employment_status in (${list})`);
  }
  if (noEmployment) parts.push(sql`emp.employment_status is null`);
  if (parts.length === 0) return null;
  return parts.length === 1 ? parts[0]! : sql`(${sql.join(parts, sql` or `)})`;
}

function employerMatch(values: string[]): SQL | null {
  for (const value of values) {
    const refused = uuidOrFalse(value);
    if (refused) return refused;
  }
  if (values.length === 0) return null;
  const list = sql.join(values.map((value) => sql`${value}`), sql`, `);
  return sql`emp.employer_subsidiary_id in (${list})`;
}

function employeeDirectoryFilterPredicate(clause: FilterClause, hrmOn: boolean): SQL | null {
  const { key, operator } = clause;
  if (
    key !== "department" &&
    key !== "employment_status" &&
    key !== "employer"
  ) {
    return null;
  }
  // A stale saved view can still name a directory filter after the switch
  // goes off; without the joins there is nothing to compare, so it matches
  // nothing rather than erroring or silently widening the list.
  if (!hrmOn) return sql`false`;
  const values = (Array.isArray(clause.value) ? clause.value : [clause.value]).map(String);
  if (values.length === 0) return operator === "in" ? sql`false` : sql`true`;
  const matched =
    key === "department"
      ? departmentMatch(values)
      : key === "employment_status"
        ? employmentStatusMatch(values)
        : employerMatch(values);
  if (!matched) return null;
  if (operator === "eq" || operator === "in") return matched;
  if (operator === "ne" || operator === "not_in") return sql`not (${matched})`;
  return null;
}

/**
 * Employee-list WHERE: the party-role base shared with vendorWhere, plus
 * the directory predicates. HRM off, every directory filter — quick or
 * saved-view — fails closed to an empty row set (the CRM-off twin of
 * customerWhere): the joins are absent, so there is nothing to compare
 * against.
 */
export function employeeWhere(
  view: ListViewConfig,
  adhoc: EntityAdhoc,
  orgId: string,
  allowedSubsidiaryIds?: Set<string> | null,
): SQL {
  const hrmOn = adhoc.hrmEnabled !== false;
  const parts: SQL[] = [rolePartyWhere("employee", view, adhoc, orgId, allowedSubsidiaryIds)];
  for (const filter of view.filters) {
    const predicate = employeeDirectoryFilterPredicate(filter, hrmOn);
    if (predicate) parts.push(sql`and ${predicate}`);
  }
  const selected = adhoc.filters ?? {};
  if (selected.department) {
    parts.push(
      hrmOn
        ? sql`and ${departmentMatch([selected.department]) ?? sql`false`}`
        : sql`and false`,
    );
  }
  if (selected.employment_status) {
    parts.push(
      hrmOn
        ? sql`and ${employmentStatusMatch([selected.employment_status]) ?? sql`false`}`
        : sql`and false`,
    );
  }
  if (selected.employer) {
    parts.push(
      hrmOn
        ? sql`and ${employerMatch([selected.employer]) ?? sql`false`}`
        : sql`and false`,
    );
  }
  return sql.join(parts, sql` `);
}

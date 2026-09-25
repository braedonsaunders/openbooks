import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";

export interface EffectiveEmployment {
  id: string;
  employerSubsidiaryId: string | null;
  departmentId: string | null;
}

export class EffectiveEmploymentError extends Error {
  readonly code: "project_unknown" | "ambiguous_employment";
  constructor(code: EffectiveEmploymentError["code"], message: string) {
    super(message);
    this.name = "EffectiveEmploymentError";
    this.code = code;
  }
}

/**
 * Resolve the one employment in force for a worker on a civil date, narrowed
 * to the project's legal employer when supplied. Historical and future
 * identity rows are excluded by the effective and recorded windows; only
 * simultaneous live matches are ambiguous.
 */
export async function resolveEffectiveEmployment(
  exec: SqlExecutor,
  input: { orgId: string; partyId: string; workedOn: string; projectId?: string | null },
): Promise<EffectiveEmployment | null> {
  let projectSubsidiaryId: string | null = null;
  if (input.projectId) {
    const project = (await exec.execute<{ subsidiaryId: string | null }>(sql`
      select subsidiary_id::text as "subsidiaryId"
        from projects where org_id = ${input.orgId}::uuid and id = ${input.projectId}::uuid
    `)).rows[0];
    if (!project) {
      throw new EffectiveEmploymentError(
        "project_unknown",
        `Project ${input.projectId} is unknown in this organization — choose a project in the worker's employing entity.`,
      );
    }
    projectSubsidiaryId = project.subsidiaryId;
  }
  const rows = (await exec.execute<{ id: string; employerSubsidiaryId: string | null; departmentId: string | null }>(sql`
    select e.id::text as id,
           e.employer_subsidiary_id::text as "employerSubsidiaryId",
           (select av.department_id::text
              from employment_assignment_versions av
             where av.org_id = e.org_id and av.employment_id = e.id
               and av.is_primary and av.recorded_until is null
               and av.effective_from <= ${input.workedOn}::date
               and (av.effective_to is null or av.effective_to > ${input.workedOn}::date)
             order by av.version_no desc limit 1) as "departmentId"
      from worker_employments e
      join worker_employment_versions v
        on v.org_id = e.org_id and v.employment_id = e.id
     where e.org_id = ${input.orgId}::uuid
       and e.worker_party_id = ${input.partyId}::uuid
       and v.recorded_until is null
       and v.effective_from <= ${input.workedOn}::date
       and (v.effective_to is null or v.effective_to > ${input.workedOn}::date)
       and v.status in ('active', 'on_leave', 'suspended')
       and (${projectSubsidiaryId}::uuid is null
            or e.employer_subsidiary_id = ${projectSubsidiaryId}::uuid)
     order by e.id
     limit 2
  `)).rows;
  if (rows.length > 1) {
    throw new EffectiveEmploymentError(
      "ambiguous_employment",
      `Worker ${input.partyId} has multiple employments effective ${input.workedOn}${input.projectId ? ` for project ${input.projectId}` : ""} — correct the employment dates or legal-entity assignment before processing these hours.`,
    );
  }
  return rows[0] ?? null;
}

export async function primaryDepartmentForEmploymentAsOf(
  exec: SqlExecutor,
  input: { orgId: string; employmentId: string; workedOn: string },
): Promise<string | null> {
  const rows = (await exec.execute<{ departmentId: string | null }>(sql`
    select department_id::text as "departmentId"
      from employment_assignment_versions
     where org_id = ${input.orgId}::uuid and employment_id = ${input.employmentId}::uuid
       and is_primary and recorded_until is null
       and effective_from <= ${input.workedOn}::date
       and (effective_to is null or effective_to > ${input.workedOn}::date)
     order by version_no desc
     limit 2
  `)).rows;
  if (rows.length > 1) {
    throw new EffectiveEmploymentError(
      "ambiguous_employment",
      `Employment ${input.employmentId} has overlapping primary department assignments effective ${input.workedOn} — correct the assignment dates before pricing the day.`,
    );
  }
  return rows[0]?.departmentId ?? null;
}

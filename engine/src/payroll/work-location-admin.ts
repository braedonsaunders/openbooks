import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";

export interface PayrollWorkLocationEmployee {
  employmentId: string;
  employeeName: string;
  subsidiaryName: string;
}

export interface PayrollWorkLocationRow {
  id: string;
  region: string;
  subregion: string | null;
  serviceDays: number | null;
  workShare: string | null;
  source: string;
  evidenceDocumentId: string | null;
  changeReason: string | null;
}

export interface PayrollWorkLocationInput {
  employmentId: string;
  periodStart: string;
  periodEnd: string;
  region: string;
  subregion?: string | null;
  serviceDays?: number | null;
  workShare?: string | null;
  source: "hr_records" | "certificate" | "adequate_records";
  evidenceDocumentId?: string | null;
  changeReason: string;
}

export async function listPayrollWorkLocations(input: {
  orgId: string;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
  detail?: { employmentId: string; periodStart: string; periodEnd: string };
}): Promise<
  | { kind: "employees"; employees: PayrollWorkLocationEmployee[] }
  | { kind: "employment_out_of_scope" }
  | { kind: "detail"; employees: PayrollWorkLocationEmployee[]; rows: PayrollWorkLocationRow[] }
> {
  const orgId = input.orgId;
  const employees = await db.execute<PayrollWorkLocationEmployee>(
    sql`
    select employment.id as "employmentId", party.display_name as "employeeName",
           subsidiary.name as "subsidiaryName"
      from worker_employments employment
      join employee_payroll_profiles profile
        on profile.org_id = employment.org_id and profile.employment_id = employment.id
      join parties party
        on party.org_id = employment.org_id and party.id = employment.worker_party_id
      join subsidiaries subsidiary
        on subsidiary.org_id = employment.org_id and subsidiary.id = employment.employer_subsidiary_id
      join worker_employment_versions version
        on version.org_id = employment.org_id and version.employment_id = employment.id
       and version.recorded_until is null and version.effective_to is null
       and version.status in ('active', 'on_leave')
     where employment.org_id = ${orgId} and subsidiary.is_active and not subsidiary.is_elimination
       and (${input.allowedSubsidiaryIds === null}::boolean
         or employment.employer_subsidiary_id = any(${`{${[...(input.allowedSubsidiaryIds ?? [])].join(",")}}`}::uuid[]))
     order by party.display_name, employment.id
  `,
    "objects",
  );
  if (!input.detail) return { kind: "employees", employees };

  const { employmentId, periodStart, periodEnd } = input.detail;
  const allowed = await db.execute(
    sql`
    select employment.id
      from worker_employments employment
      join subsidiaries subsidiary
        on subsidiary.org_id = employment.org_id and subsidiary.id = employment.employer_subsidiary_id
     where employment.org_id = ${orgId} and employment.id = ${employmentId}
       and subsidiary.is_active and not subsidiary.is_elimination
       and (${input.allowedSubsidiaryIds === null}::boolean
         or employment.employer_subsidiary_id = any(${`{${[...(input.allowedSubsidiaryIds ?? [])].join(",")}}`}::uuid[]))
  `,
    "objects",
  );
  if (!allowed[0]) return { kind: "employment_out_of_scope" };

  const rows = await db.execute<PayrollWorkLocationRow>(
    sql`
    select id, region, subregion, service_days as "serviceDays", work_share::text as "workShare",
           source, evidence_document_id as "evidenceDocumentId", change_reason as "changeReason"
      from payroll_work_location_allocations
     where org_id = ${orgId} and employment_id = ${employmentId}
       and period_start = ${periodStart}::date and period_end = ${periodEnd}::date
     order by region, subregion, id
  `,
    "objects",
  );
  return { kind: "detail", employees, rows };
}

export async function createPayrollWorkLocation(
  orgId: string,
  actorId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  input: PayrollWorkLocationInput,
): Promise<{ kind: "saved"; row: PayrollWorkLocationRow } | { kind: "employment_out_of_scope" }> {
  const allowed = await db.execute(
    sql`
    select employment.id
      from worker_employments employment
      join subsidiaries subsidiary
        on subsidiary.org_id = employment.org_id and subsidiary.id = employment.employer_subsidiary_id
     where employment.org_id = ${orgId} and employment.id = ${input.employmentId}
       and subsidiary.is_active and not subsidiary.is_elimination
       and (${allowedSubsidiaryIds === null}::boolean
         or employment.employer_subsidiary_id = any(${`{${[...(allowedSubsidiaryIds ?? [])].join(",")}}`}::uuid[]))
  `,
    "objects",
  );
  if (!allowed[0]) return { kind: "employment_out_of_scope" };

  const row = await withOrgTransaction(orgId, async () => {
    const result = await db.execute<PayrollWorkLocationRow>(
      sql`
      insert into payroll_work_location_allocations
        (org_id, employment_id, period_start, period_end, region, subregion, service_days,
         work_share, source, evidence_document_id, change_reason, created_by, updated_by)
      values (${orgId}, ${input.employmentId}, ${input.periodStart}::date, ${input.periodEnd}::date,
        ${input.region}, ${input.subregion ?? null}, ${input.serviceDays ?? null},
        ${input.workShare ?? null}, ${input.source}, ${input.evidenceDocumentId ?? null},
        ${input.changeReason}, ${actorId}, ${actorId})
      returning id, region, subregion, service_days as "serviceDays", work_share::text as "workShare",
        source, evidence_document_id as "evidenceDocumentId", change_reason as "changeReason"
    `,
      "objects",
    );
    if (!result[0]) throw new Error("work location allocation insert returned no row");
    return result[0];
  });
  return { kind: "saved", row };
}

export async function updatePayrollWorkLocation(
  orgId: string,
  actorId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  input: PayrollWorkLocationInput & { id: string },
): Promise<
  | { kind: "saved"; row: PayrollWorkLocationRow }
  | { kind: "employment_out_of_scope" }
  | { kind: "not_found" }
> {
  const allowed = await db.execute(
    sql`
    select employment.id
      from worker_employments employment
      join subsidiaries subsidiary
        on subsidiary.org_id = employment.org_id and subsidiary.id = employment.employer_subsidiary_id
     where employment.org_id = ${orgId} and employment.id = ${input.employmentId}
       and subsidiary.is_active and not subsidiary.is_elimination
       and (${allowedSubsidiaryIds === null}::boolean
         or employment.employer_subsidiary_id = any(${`{${[...(allowedSubsidiaryIds ?? [])].join(",")}}`}::uuid[]))
  `,
    "objects",
  );
  if (!allowed[0]) return { kind: "employment_out_of_scope" };

  const row = await withOrgTransaction(orgId, async () => {
    const result = await db.execute<PayrollWorkLocationRow>(
      sql`
      update payroll_work_location_allocations
         set region = ${input.region}, subregion = ${input.subregion ?? null},
             service_days = ${input.serviceDays ?? null}, work_share = ${input.workShare ?? null},
             source = ${input.source}, evidence_document_id = ${input.evidenceDocumentId ?? null},
             change_reason = ${input.changeReason}, updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and employment_id = ${input.employmentId} and id = ${input.id}
         and period_start = ${input.periodStart}::date and period_end = ${input.periodEnd}::date
       returning id, region, subregion, service_days as "serviceDays", work_share::text as "workShare",
         source, evidence_document_id as "evidenceDocumentId", change_reason as "changeReason"
    `,
      "objects",
    );
    return result[0];
  });
  return row ? { kind: "saved", row } : { kind: "not_found" };
}

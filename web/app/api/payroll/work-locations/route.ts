import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "@openbooks/engine/src/platform/db.ts";
import { guardFeaturePermission } from "../../../../lib/feature-gates";
import { guardRootSubsidiaryScope } from "../../../../lib/authz";
import { isUuid } from "../../../../lib/list-params";
import { parseJsonBody } from "../../../../lib/api/json";
import { z } from "zod";

export const dynamic = "force-dynamic";

const dateShape = /^\d{4}-\d{2}-\d{2}$/;
const shareShape = /^(?:0(?:\.\d{1,10})?|1(?:\.0{1,10})?)$/;

export async function GET(request: Request) {
  const gate = await guardFeaturePermission("payroll.manage", "payroll");
  if (gate instanceof NextResponse) return gate;
  const scopeDenied = await guardRootSubsidiaryScope(gate);
  if (scopeDenied) return scopeDenied;
  const orgId = gate.user.orgId;
  const employees = await db.execute<{ employmentId: string; employeeName: string; subsidiaryName: string }>(sql`
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
       and (${gate.allowedSubsidiaryIds === null}::boolean
         or employment.employer_subsidiary_id = any(${`{${[...(gate.allowedSubsidiaryIds ?? [])].join(",")}}`}::uuid[]))
     order by party.display_name, employment.id
  `);
  const url = new URL(request.url);
  const employmentId = url.searchParams.get("employmentId");
  const periodStart = url.searchParams.get("periodStart");
  const periodEnd = url.searchParams.get("periodEnd");
  if (!employmentId && !periodStart && !periodEnd) return NextResponse.json({ employees: employees.rows });
  if (!employmentId || !isUuid(employmentId) || !periodStart || !dateShape.test(periodStart)
      || !periodEnd || !dateShape.test(periodEnd) || periodStart > periodEnd) {
    return NextResponse.json({ error: "employment and a valid payroll period are required" }, { status: 422 });
  }
  // Same predicate as POST/PATCH: the detail rows name work shares, service
  // days and evidence for one employment, so an employment outside the
  // caller payroll scope reads as missing instead of leaking by UUID.
  const allowed = await db.execute(sql`
    select employment.id
      from worker_employments employment
      join subsidiaries subsidiary
        on subsidiary.org_id = employment.org_id and subsidiary.id = employment.employer_subsidiary_id
     where employment.org_id = ${orgId} and employment.id = ${employmentId}
       and subsidiary.is_active and not subsidiary.is_elimination
       and (${gate.allowedSubsidiaryIds === null}::boolean
         or employment.employer_subsidiary_id = any(${`{${[...(gate.allowedSubsidiaryIds ?? [])].join(",")}}`}::uuid[]))
  `);
  if (!allowed.rows[0]) return NextResponse.json({ error: "employment is outside your payroll scope" }, { status: 404 });
  const rows = await db.execute(sql`
    select id, region, subregion, service_days as "serviceDays", work_share::text as "workShare",
           source, evidence_document_id as "evidenceDocumentId", change_reason as "changeReason"
      from payroll_work_location_allocations
     where org_id = ${orgId} and employment_id = ${employmentId}
       and period_start = ${periodStart}::date and period_end = ${periodEnd}::date
     order by region, subregion, id
  `);
  return NextResponse.json({ employees: employees.rows, rows: rows.rows });
}

const saveSchema = z.object({
  employmentId: z.string().refine(isUuid),
  periodStart: z.string().regex(dateShape),
  periodEnd: z.string().regex(dateShape),
  region: z.string().trim().min(1).max(32),
  subregion: z.string().trim().max(64).nullable().optional(),
  serviceDays: z.number().int().nonnegative().nullable().optional(),
  workShare: z.string().regex(shareShape).nullable().optional(),
  source: z.enum(["hr_records", "certificate", "adequate_records"]),
  evidenceDocumentId: z.string().refine(isUuid).nullable().optional(),
  changeReason: z.string().trim().min(1).max(1000),
}).refine((value) => value.periodStart <= value.periodEnd, {
  message: "period start must not follow period end",
}).refine((value) => (value.serviceDays != null) !== (value.workShare != null), {
  message: "enter either service days or a work share",
});

export async function POST(request: Request) {
  const gate = await guardFeaturePermission("payroll.manage", "payroll");
  if (gate instanceof NextResponse) return gate;
  const scopeDenied = await guardRootSubsidiaryScope(gate);
  if (scopeDenied) return scopeDenied;
  const parsed = await parseJsonBody(request, saveSchema, { status: 422 });
  if (!parsed.ok) return parsed.response;
  const value = parsed.data;
  const orgId = gate.user.orgId;
  const allowed = await db.execute(sql`
    select employment.id
      from worker_employments employment
      join subsidiaries subsidiary
        on subsidiary.org_id = employment.org_id and subsidiary.id = employment.employer_subsidiary_id
     where employment.org_id = ${orgId} and employment.id = ${value.employmentId}
       and subsidiary.is_active and not subsidiary.is_elimination
       and (${gate.allowedSubsidiaryIds === null}::boolean
         or employment.employer_subsidiary_id = any(${`{${[...(gate.allowedSubsidiaryIds ?? [])].join(",")}}`}::uuid[]))
  `);
  if (!allowed.rows[0]) return NextResponse.json({ error: "employment is outside your payroll scope" }, { status: 404 });
  const saved = await withOrgTransaction(orgId, async () => {
    const row = await db.execute(sql`
      insert into payroll_work_location_allocations
        (org_id, employment_id, period_start, period_end, region, subregion, service_days,
         work_share, source, evidence_document_id, change_reason, created_by, updated_by)
      values (${orgId}, ${value.employmentId}, ${value.periodStart}::date, ${value.periodEnd}::date,
        ${value.region}, ${value.subregion ?? null}, ${value.serviceDays ?? null},
        ${value.workShare ?? null}, ${value.source}, ${value.evidenceDocumentId ?? null},
        ${value.changeReason}, ${gate.user.id}, ${gate.user.id})
      returning id, region, subregion, service_days as "serviceDays", work_share::text as "workShare",
        source, evidence_document_id as "evidenceDocumentId", change_reason as "changeReason"
    `);
    if (!row.rows[0]) throw new Error("work location allocation insert returned no row");
    return row.rows[0];
  });
  return NextResponse.json({ row: saved }, { status: 201 });
}

const updateSchema = saveSchema.extend({ id: z.string().refine(isUuid) });

export async function PATCH(request: Request) {
  const gate = await guardFeaturePermission("payroll.manage", "payroll");
  if (gate instanceof NextResponse) return gate;
  const scopeDenied = await guardRootSubsidiaryScope(gate);
  if (scopeDenied) return scopeDenied;
  const parsed = await parseJsonBody(request, updateSchema, { status: 422 });
  if (!parsed.ok) return parsed.response;
  const value = parsed.data;
  const orgId = gate.user.orgId;
  const allowed = await db.execute(sql`
    select employment.id
      from worker_employments employment
      join subsidiaries subsidiary
        on subsidiary.org_id = employment.org_id and subsidiary.id = employment.employer_subsidiary_id
     where employment.org_id = ${orgId} and employment.id = ${value.employmentId}
       and subsidiary.is_active and not subsidiary.is_elimination
       and (${gate.allowedSubsidiaryIds === null}::boolean
         or employment.employer_subsidiary_id = any(${`{${[...(gate.allowedSubsidiaryIds ?? [])].join(",")}}`}::uuid[]))
  `);
  if (!allowed.rows[0]) return NextResponse.json({ error: "employment is outside your payroll scope" }, { status: 404 });
  const row = await withOrgTransaction(orgId, async () => db.execute(sql`
    update payroll_work_location_allocations
       set region = ${value.region}, subregion = ${value.subregion ?? null},
           service_days = ${value.serviceDays ?? null}, work_share = ${value.workShare ?? null},
           source = ${value.source}, evidence_document_id = ${value.evidenceDocumentId ?? null},
           change_reason = ${value.changeReason}, updated_at = now(), updated_by = ${gate.user.id}
     where org_id = ${orgId} and employment_id = ${value.employmentId} and id = ${value.id}
       and period_start = ${value.periodStart}::date and period_end = ${value.periodEnd}::date
     returning id, region, subregion, service_days as "serviceDays", work_share::text as "workShare",
       source, evidence_document_id as "evidenceDocumentId", change_reason as "changeReason"
  `));
  if (!row.rows[0]) return NextResponse.json({ error: "allocation was not found for this employment period" }, { status: 404 });
  return NextResponse.json({ row: row.rows[0] });
}

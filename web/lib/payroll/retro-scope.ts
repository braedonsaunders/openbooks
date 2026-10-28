import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import type { Authz } from "../authz";
import { guardSubsidiaryScope } from "../authz";
import { subsidiaryVisibleFilter } from "../subsidiaries";
import { guardPayrollEmployees } from "./subsidiary-scope";

/** Opaque refusal shared by the payroll route and application commands. */
export class RetroScopeNotFound extends Error {
  constructor() {
    super("payroll record not found");
  }
}

/** Resolve and prove the full retro source population before detection runs. */
export async function scopedRetroEmployees(
  gate: Authz,
  payScheduleId: string,
  requested: string[] | undefined,
): Promise<string[]> {
  if (gate.allowedSubsidiaryIds === null) return requested ?? [];

  const root =
    (
      await db.execute<{ id: string }>(
        sql`
    select id from subsidiaries
     where org_id = ${gate.user.orgId} and parent_id is null and is_active
     order by created_at limit 1`,
        "objects",
      )
    )[0]?.id ?? null;
  const schedule = (
    await db.execute<{ subsidiaryId: string | null }>(
      sql`
    select coalesce(s.subsidiary_id, ${root}) as "subsidiaryId"
      from pay_schedules s
     where s.org_id = ${gate.user.orgId} and s.id = ${payScheduleId} and s.is_active`,
      "objects",
    )
  )[0];
  if (guardSubsidiaryScope(gate, schedule?.subsidiaryId)) throw new RetroScopeNotFound();

  const sourceRuns = await db.execute<{ subsidiaryId: string | null }>(
    sql`
    select coalesce(d.subsidiary_id, ${root}) as "subsidiaryId"
      from pay_runs r
      join documents d on d.id = r.document_id and d.org_id = r.org_id
     where r.org_id = ${gate.user.orgId}
       and r.pay_schedule_id = ${payScheduleId}
       and r.run_status = 'committed'
       and r.run_type <> 'retro'`,
    "objects",
  );
  for (const sourceRun of sourceRuns) {
    if (guardSubsidiaryScope(gate, sourceRun.subsidiaryId)) throw new RetroScopeNotFound();
  }

  if (requested) {
    if (await guardPayrollEmployees(gate, requested)) throw new RetroScopeNotFound();
    return requested;
  }

  const rows = await db.execute<{ id: string }>(
    sql`
    select distinct s.employee_party_id as id
      from pay_stubs s
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
      join parties p on p.id = s.employee_party_id and p.org_id = s.org_id
     where s.org_id = ${gate.user.orgId}
       and r.pay_schedule_id = ${payScheduleId}
       and r.run_status = 'committed'
       and r.run_type <> 'retro'
       ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, gate.allowedSubsidiaryIds)}`,
    "objects",
  );
  const ids = rows.map((row) => row.id);
  if (ids.length === 0) throw new RetroScopeNotFound();
  return ids;
}

export async function assertRetroExcludedSourcesInScope(
  gate: Authz,
  payScheduleId: string,
  sourceIds: string[] | undefined,
): Promise<void> {
  if (gate.allowedSubsidiaryIds === null || !sourceIds?.length) return;
  const rows = await db.execute<{ id: string }>(
    sql`
    select r.document_id as id
      from pay_runs r
      join documents d on d.id = r.document_id and d.org_id = r.org_id
     where r.org_id = ${gate.user.orgId}
       and r.pay_schedule_id = ${payScheduleId}
       and r.document_id in (${sql.join(
         sourceIds.map((id) => sql`${id}`),
         sql`, `,
       )})
       ${subsidiaryVisibleFilter(sql`d.subsidiary_id`, gate.allowedSubsidiaryIds)}`,
    "objects",
  );
  if (rows.length !== new Set(sourceIds).size) throw new RetroScopeNotFound();
}

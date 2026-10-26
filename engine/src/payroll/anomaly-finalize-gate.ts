import { payScheduleOwnerSql } from "./schedule-owner.ts";
import { sql } from "drizzle-orm";
import { PayrollError } from "./error.ts";
import type { SqlExecutor } from "../platform/db.ts";

export interface PayrollAnomalyFinalizeCheck {
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly openBlockCount: number;
  readonly openBlocks: readonly { readonly id: string; readonly kind: string }[];
}

/** Serialize anomaly review writes with the native commit decision. */
export async function lockPayrollAnomalyReview(exec: SqlExecutor, orgId: string): Promise<void> {
  await exec.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`payroll-anomaly-review:${orgId}`}, 0))`,
  );
}

/**
 * Read the blocking HRM anomaly flags that apply to this exact payroll run.
 * The run's retained stubs scope the affected employments. Period-wide flags
 * follow that exact roster even when current profile scheduling changes;
 * profile changes cannot erase an unresolved review of the retained period.
 * Acknowledgement is a reviewed lifecycle state, so only open flags refuse.
 */
export async function payrollAnomalyFinalizeCheck(
  exec: SqlExecutor,
  input: { readonly orgId: string; readonly documentId: string },
): Promise<PayrollAnomalyFinalizeCheck> {
  const run = (
    await exec.execute<{
      periodFrom: string;
      periodTo: string;
      subsidiaryId: string | null;
      scheduleSubsidiaryId: string | null;
    }>(
      sql`
    select r.period_start::text as "periodFrom", r.period_end::text as "periodTo",
           d.subsidiary_id::text as "subsidiaryId", owner.id::text as "scheduleSubsidiaryId"
      from pay_runs r
      join documents d on d.org_id = r.org_id and d.id = r.document_id
      join pay_schedules ps on ps.org_id = r.org_id and ps.id = r.pay_schedule_id and ps.is_active
      join lateral (${payScheduleOwnerSql(input.orgId, sql`ps.subsidiary_id`)}) owner on true
     where r.org_id = ${input.orgId}::uuid and r.document_id = ${input.documentId}::uuid
  `,
      "objects",
    )
  )[0];
  if (!run) throw new PayrollError("pay run not found");
  if (!run.subsidiaryId || run.scheduleSubsidiaryId !== run.subsidiaryId) {
    throw new PayrollError(
      "Payroll anomaly review requires the run and pay schedule to identify the same legal entity — correct the schedule before committing",
    );
  }

  const blocks = await exec.execute<{ id: string; kind: string }>(
    sql`
    select distinct f.id::text as id, f.kind
      from pay_runs r
      join documents d on d.org_id = r.org_id and d.id = r.document_id
      join pay_schedules ps on ps.org_id = r.org_id and ps.id = r.pay_schedule_id
      join pay_stubs s on s.org_id = r.org_id and s.pay_run_document_id = r.document_id
      join worker_employments e on e.org_id = s.org_id and e.id = s.employment_id
       and e.worker_party_id = s.employee_party_id
      join payroll_anomaly_flags f
        on f.org_id = r.org_id
       and (f.employment_id = s.employment_id or (f.employment_id is null and f.run_document_id = r.document_id))
       and (f.run_document_id = r.document_id or f.run_document_id is null)
       and f.severity = 'block' and f.status = 'open'
       and f.pay_period_from <= r.period_end and f.pay_period_to >= r.period_start
     where r.org_id = ${input.orgId}::uuid and r.document_id = ${input.documentId}::uuid
       and d.subsidiary_id = ${run.scheduleSubsidiaryId}::uuid
     order by id
  `,
    "objects",
  );
  return {
    periodFrom: run.periodFrom,
    periodTo: run.periodTo,
    openBlockCount: blocks.length,
    openBlocks: blocks,
  };
}

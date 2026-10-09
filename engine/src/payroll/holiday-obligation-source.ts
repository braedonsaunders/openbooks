import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { PayrollError } from "./error.ts";
import { payrollSubsidiaryScopeFilter, type PayrollSubsidiaryScope } from "./scope.ts";
import { readAdjudicatedHolidayPayment } from "./holiday-payment-contract.ts";
import type { SourceBoundHolidayPayment } from "./holiday-payment-source.ts";
import { effectivePayRateSql } from "./rate.ts";
import { resolvePayRate, resolvePayrollFxSource } from "./run-calculation-support.ts";

export interface HolidayObligationSource {
  id: string;
  employeePartyId: string;
  employmentId: string;
  subsidiaryId: string;
  paymentDate: string;
  evidence: SourceBoundHolidayPayment;
  profile: Record<string, unknown>;
  foreignClaim: { id: string; documentId: string; status: string } | null;
  component: Record<string, unknown> | null;
  wage?: { resolved: NonNullable<Awaited<ReturnType<typeof resolvePayRate>>>; source: Record<string, unknown>; fx: Awaited<ReturnType<typeof resolvePayrollFxSource>> };
}

/** Older databases cannot contain this newly introduced class of obligation.
 * A partial deployment is refused, never interpreted as no unpaid holiday. */
export async function holidayObligationsAvailable(tx: SqlExecutor): Promise<boolean> {
  const row = (await tx.execute<{ obligations: boolean; occurrences: boolean; allocations: boolean }>(sql`select
    to_regclass('public.payroll_holiday_obligations') is not null as obligations,
    to_regclass('public.payroll_holiday_occurrences') is not null as occurrences,
    to_regclass('public.pay_run_holiday_allocations') is not null as allocations`)).rows[0];
  if (!row) throw new PayrollError("The holiday entitlement schema could not be resolved.");
  if (!row.obligations && !row.occurrences && !row.allocations) return false;
  if (!row.obligations || !row.occurrences || !row.allocations) {
    throw new PayrollError("The holiday entitlement upgrade is incomplete; complete the native database migration before calculating payroll.");
  }
  return true;
}

export async function approvedHolidayOccurrenceDates(tx: SqlExecutor, input: {
  orgId: string; employeePartyId: string; subsidiaryId: string | null | undefined; from: string; to: string;
}): Promise<ReadonlySet<string>> {
  if (!await holidayObligationsAvailable(tx)) return new Set();
  if (!input.subsidiaryId) throw new PayrollError("Resolve the employee's legal employer before selecting approved holiday entitlements.");
  const dates = (await tx.execute<{ date: string }>(sql`select occurrence.holiday_date::text as date
    from payroll_holiday_occurrences occurrence
    join payroll_holiday_obligations o on o.org_id=occurrence.org_id and o.id=occurrence.obligation_id
    join financial_changes f on f.org_id=o.org_id and f.id=o.change_id and f.status='applied'
    where occurrence.org_id=${input.orgId} and occurrence.employee_party_id=${input.employeePartyId}
      and occurrence.subsidiary_id=${input.subsidiaryId} and occurrence.holiday_date between ${input.from}::date and ${input.to}::date
    order by occurrence.holiday_date`)).rows;
  return new Set(dates.map(row => row.date));
}

/** Includes both due payments and calendar occurrences already owned by an
 * independently approved entitlement. Excludes this run's derived claim so
 * recalculation and commit see the same authoritative source. */
export async function holidayObligationRunSource(tx: SqlExecutor, orgId: string, documentId: string, allowed?: PayrollSubsidiaryScope,
  candidate?: { employeePartyId: string; employmentId: string },
): Promise<HolidayObligationSource[]> {
  if (!await holidayObligationsAvailable(tx)) return [];
  const rows = (await tx.execute<HolidayObligationSource & { currency: string }>(sql`select
    o.id, o.employee_party_id as "employeePartyId", o.employment_id as "employmentId", o.subsidiary_id as "subsidiaryId",
    o.payment_date::text as "paymentDate", o.evidence, f.before_state->'profile' as profile, d.currency,
    (select to_jsonb(c) from pay_run_holiday_allocations own_claim join pay_components c on c.org_id=own_claim.org_id and c.id=own_claim.component_id
      where own_claim.org_id=o.org_id and own_claim.obligation_id=o.id and own_claim.pay_run_document_id=r.document_id) as component,
    (select jsonb_build_object('id',a.id,'documentId',a.pay_run_document_id,'status',a.status)
      from pay_run_holiday_allocations a where a.org_id=o.org_id and a.obligation_id=o.id
        and a.status<>'voided' and a.pay_run_document_id<>r.document_id) as "foreignClaim"
    from pay_runs r join documents d on d.org_id=r.org_id and d.id=r.document_id
    ${candidate ? sql`join lateral (select r.org_id,${candidate.employeePartyId}::uuid as employee_party_id,${candidate.employmentId}::uuid as employment_id) s on true`
      : sql`join pay_stubs s on s.org_id=r.org_id and s.pay_run_document_id=r.document_id`}
    join payroll_holiday_obligations o on o.org_id=s.org_id and o.employee_party_id=s.employee_party_id and o.employment_id=s.employment_id
    join financial_changes f on f.org_id=o.org_id and f.id=o.change_id and f.status='applied'
    where r.org_id=${orgId} and r.document_id=${documentId} and r.run_type='regular'
      ${payrollSubsidiaryScopeFilter(sql`o.subsidiary_id`, allowed)}
      and (o.payment_date=r.pay_date or exists(select 1 from payroll_holiday_occurrences occurrence
        where occurrence.org_id=o.org_id and occurrence.obligation_id=o.id and occurrence.holiday_date between r.period_start and r.period_end))
    order by o.employee_party_id,o.id`)).rows;
  const run = (await tx.execute<{ payDate: string }>(sql`select pay_date::text as "payDate" from pay_runs where org_id=${orgId} and document_id=${documentId}`)).rows[0];
  const result: HolidayObligationSource[] = [];
  for (const row of rows) {
    const { currency, ...source } = row;
    const instruction = readAdjudicatedHolidayPayment(source.evidence.instruction);
    if (source.paymentDate === run?.payDate) {
      if (!currency) throw new PayrollError("Resolve the regular payroll currency before pricing an unpaid holiday entitlement.");
      const resolved = await resolvePayRate(tx, orgId, source.employeePartyId, instruction.wageBasisDate, currency);
      if (!resolved) throw new PayrollError("The unpaid holiday entitlement has no usable wage on its approved wage-basis date; review dated employee wages before calculating.");
      const wage = (await tx.execute<Record<string, unknown>>(sql`select w.id, w.basis, w.rate::text, w.annual_hours::text, w.currency,
        w.payroll_rate_scale,w.payroll_amount_rounding,w.effective_from::text,w.effective_to::text,w.updated_at::text
        from ${effectivePayRateSql({ org: sql`${orgId}`, employee: sql`${source.employeePartyId}`, onDate: sql`${instruction.wageBasisDate}`, selectList: sql`w.*` })} w`)).rows[0];
      if (!wage) throw new PayrollError("The dated holiday wage source could not be retained; retry calculation.");
      const fx = await resolvePayrollFxSource(tx, orgId, String(wage.currency), currency, instruction.wageBasisDate);
      source.wage = { resolved, source: wage, fx };
    }
    result.push(source);
  }
  return result;
}

export async function clearCalculatedHolidayAllocations(tx: SqlExecutor, orgId: string, documentId: string): Promise<void> {
  if (!await holidayObligationsAvailable(tx)) return;
  await tx.execute(sql`delete from pay_run_holiday_allocations where org_id=${orgId} and pay_run_document_id=${documentId}`);
}

import { payrollEmploymentOverlapsPeriod, payrollEpisodeDate } from "./employment-roster.ts";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { businessToday } from "../platform/business-date.ts";
import { hasUsablePayRateSql } from "./rate.ts";
import { loadWageTimeEntries, sumWageHoursByEmployee } from "./wage-hours.ts";
import { payrollSettings } from "./run-setup.ts";
import { payrollSubsidiaryScopeFilter, type PayrollSubsidiaryScope } from "./scope.ts";
import { effectiveFilingAccountSql } from "./filing.ts";
import { payrollTaxYearForDate } from "./packs.ts";

/** Shared readiness context: run and population scope for the pay-run pre-flight checks. */

export const CONTROL_ACCOUNTS_HREF = "/admin/setup/company#control-accounts";

/**
 * Pre-flight for a pay run: what must be fixed before it can calculate, what
 * the operator should look at before committing, what the payday actually
 * costs to fund, and what changed for each employee since their last pay.
 *
 * Blocker vs warning is a hard line. A blocker means the run cannot produce a
 * correct stub or a balanced posting (missing wage, unmapped statutory
 * account, closed period). Everything else is advisory — payroll teams
 * legitimately pay someone with zero hours, or run a period twice, and the
 * product's job is to make them see it, not to refuse.
 */

export type ReadinessSeverity = "blocker" | "warning";

export interface ReadinessItem {
  severity: ReadinessSeverity;
  /** Stable code; the UI localizes it and links to the fix. */
  code: string;
  /** Employees the item concerns (empty = a run/org-level item). */
  employees: { partyId: string; name: string }[];
  /** Substitution for the message (slot key, period name, …). */
  detail?: string;
  /** Where the operator resolves it, when there is one obvious place. */
  href?: string;
  /**
   * A one-click engine resolution the operator can run from the readiness
   * panel (stable code, e.g. payroll.resolve-employment-links). The UI posts
   * it to the matching run action; the engine still refuses ambiguity by
   * name, so the action never guesses.
   */
  action?: string;
}

export interface PayRunReadiness {
  items: ReadinessItem[];
  blockers: number;
  warnings: number;
  /** Employees in scope after exclusions — the run's actual population. */
  included: number;
}
/** The columns the statutory-rate scope check reads off a payroll population. */
export type RateScopeRow = Pick<
  ScopeRow,
  "employee_party_id" | "name" | "country" | "province" | "residence_region" | "filing_account_id" | "subsidiary_id"
>;

export type ScopeRow = {
  employee_party_id: string;
  subsidiary_id: string | null;
  name: string;
  pay_basis: string;
  country: string;
  province: string | null;
  /** Employee's state of residence when it differs from the work state; null = work state. */
  residence_region: string | null;
  /** The employment attribute that overrides the region derivation; null =
   *  derive the labour jurisdiction from the work region. */
  labour_jurisdiction: string | null;
  has_wage: boolean;
  has_employment_link: boolean;
  /**
   * Workers-compensation rate class on the active employee role; null means
   * none is assigned — covered only when the payroll profile records an
   * explicit exemption instead.
   */
  worker_comp_group_id: string | null;
  /** Explicit workers-compensation exclusion with a reason (0662). */
  wcb_exempt: boolean;
  approved_hours: string;
  hired_on: string | null;
  terminated_on: string | null;
  paid_in_period: boolean;
  has_bank: boolean;
  has_sin: boolean;
  profile_payment_method: string | null;
  party_payment_method: string | null;
  /**
   * The filing identity the employee is paid under, resolved with the SAME
   * fragment the run and the year-end returns use — never re-derived here.
   * Statutory rates that are assigned per account (an experience-rated SUI
   * rate) resolve against it.
   */
  filing_account_id: string | null;
};
/**
 * The regions a payroll population occupies, per pack country — the demand
 * side of the account slots' appliesWhen. Callers pass it to packSlotState so
 * a run scoped to Ontario never demands Québec accounts. A country with no
 * rows, or rows with a null region, demands everything: today's behaviour.
 *
 * Both the work region and the residence region occupy the set: a second
 * state has its own claim on the same wages (reciprocity), so a Washington
 * worker residing in California can owe California tax with no California
 * work region on the run. An unrecorded residence IS the work region (the
 * resolution assumes it, recorded) — never null, because null demands
 * every slot.
 */
export function regionsByCountry(
  rows: readonly { country: string; province: string | null; residence_region?: string | null }[],
): Map<string, Set<string | null>> {
  const map = new Map<string, Set<string | null>>();
  for (const row of rows) {
    const set = map.get(row.country) ?? new Set<string | null>();
    set.add(row.province ?? null);
    set.add(row.residence_region ?? row.province ?? null);
    map.set(row.country, set);
  }
  return map;
}

/**
 * The regions the org's ACTIVE payroll population occupies, per pack country
 * — the account slots' appliesWhen scoped to a roster instead of a run. The
 * /payroll overview banner walks the same packSlotState demand as the run
 * pre-flight, so it scopes by the same fact: an Ontario-only employer is
 * never told to map Québec accounts there either. No population (a new org)
 * demands everything — today's behaviour.
 */
export async function payrollPopulationRegions(
  orgId: string,
  allowedSubsidiaryIds?: PayrollSubsidiaryScope,
): Promise<Map<string, Set<string | null>>> {
  return regionsByCountry(await activePayrollPopulation(orgId, allowedSubsidiaryIds));
}
export type RunRow = {
  pay_schedule_id: string;
  period_start: string;
  period_end: string;
  pay_date: string;
  tax_year: number;
  run_type: string;
  run_status: string;
  subsidiary_id: string | null;
  document_subsidiary_id: string | null;
};

export async function runContext(
  orgId: string,
  documentId: string,
  allowedSubsidiaryIds?: PayrollSubsidiaryScope,
): Promise<RunRow | null> {
  const runs = (await db.execute<RunRow>(sql`
    select r.pay_schedule_id, r.period_start::text as period_start, r.period_end::text as period_end,
           r.pay_date::text as pay_date, r.tax_year, r.run_type, r.run_status,
           s.subsidiary_id, d.subsidiary_id as document_subsidiary_id
      from pay_runs r
      join pay_schedules s on s.id = r.pay_schedule_id and s.org_id = r.org_id
      join documents d on d.id = r.document_id and d.org_id = r.org_id
     where r.org_id = ${orgId} and r.document_id = ${documentId}
       ${payrollSubsidiaryScopeFilter(sql`d.subsidiary_id`, allowedSubsidiaryIds)}
  `, "objects"));
  return runs[0] ?? null;
}

/**
 * Everyone the run will pay, with the facts each check needs.
 *
 * The population predicates are the RUN's, not readiness's own: a
 * subsidiary-scoped pay schedule pays only that entity's employees, and an
 * employee terminated before the period started requires scoped final pay or an
 * explicit supplemental earning. Describing a different population from the
 * one that will be paid makes every per-employee count on this screen wrong.
 */
export async function scope(
  orgId: string,
  documentId: string,
  run: RunRow,
  allowedSubsidiaryIds?: PayrollSubsidiaryScope,
): Promise<ScopeRow[]> {
  const rosterColumns = {
    org: sql`prof.org_id`, employee: sql`p.id`, employment: sql`prof.employment_id`,
    employer: sql`p.subsidiary_id`, hiredOn: sql`er.hired_on`, terminatedOn: sql`er.terminated_on`,
    periodStart: sql`${run.period_start}`, periodEnd: sql`${run.period_end}`,
    runType: sql`${run.run_type}`, document: sql`${documentId}`,
  };
  const rows = (await db.execute<Omit<ScopeRow, "approved_hours">>(sql`
    select p.id as employee_party_id, p.display_name as name, prof.pay_basis, prof.country,
           ${run.document_subsidiary_id}::uuid as subsidiary_id,
           prof.province, prof.residence_region, prof.labour_jurisdiction,
           ${effectiveFilingAccountSql("prof")} as filing_account_id,
           (${payrollEpisodeDate(rosterColumns, sql`er.hired_on`)})::text as hired_on,
           (${payrollEpisodeDate(rosterColumns, sql`er.terminated_on`)})::text as terminated_on,
           prof.sin_encrypted is not null as has_sin,
           er.worker_comp_group_id,
           coalesce(prof.wcb_exempt, false) as wcb_exempt,
           prof.payment_method as profile_payment_method,
           p.payment_method as party_payment_method,
           exists (select 1 from worker_employments employment
             where employment.org_id=prof.org_id and employment.id=prof.employment_id
               and employment.worker_party_id=prof.employee_party_id
               -- A NULL party subsidiary defers to the employment's own legal
               -- employer (native Hire mints the party without one).
               and (employment.employer_subsidiary_id=p.subsidiary_id or p.subsidiary_id is null)) as has_employment_link,
           exists (
             select 1 from party_bank_accounts b
              where b.org_id = prof.org_id and b.party_id = p.id
                and b.is_active and b.approval_status = 'approved') as has_bank,
           coalesce(${hasUsablePayRateSql({
             org: sql`prof.org_id`,
             employee: sql`prof.employee_party_id`,
             onDate: run.period_end,
             payBasis: sql`prof.pay_basis`,
           })}, false) as has_wage,
           exists (
             select 1 from pay_stubs s2
               join pay_runs r2 on r2.document_id = s2.pay_run_document_id and r2.org_id = s2.org_id
              where s2.org_id = prof.org_id and s2.employee_party_id = prof.employee_party_id
                and s2.pay_run_document_id <> ${documentId}
                and r2.run_status = 'committed'
                and r2.period_start <= ${run.period_end}
                and r2.period_end >= ${run.period_start}) as paid_in_period
      from employee_payroll_profiles prof
      join parties p on p.id = prof.employee_party_id and p.org_id = prof.org_id
      left join employee_roles er on er.party_id = p.id and er.org_id = prof.org_id
     where prof.org_id = ${orgId} and prof.pay_schedule_id = ${run.pay_schedule_id} and prof.is_active
       -- Shared eligibility also admits documented earlier employment episodes.
       and ${payrollEmploymentOverlapsPeriod(rosterColumns)}
       and (${run.subsidiary_id}::uuid is null or p.subsidiary_id = ${run.subsidiary_id}::uuid)
       ${payrollSubsidiaryScopeFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds)}
       and not exists (
         select 1 from pay_run_adjustments a
          where a.org_id = ${orgId} and a.pay_run_document_id = ${documentId}
            and a.adjustment_type = 'exclude' and a.employee_party_id = p.id)
     order by p.display_name
  `, "objects"));
  // Approved hours preview exactly what Calculate prices (wage-hours read),
  // so readiness can never warn about time the run will pay — or stay quiet
  // about time it will not.
  const wageHours = sumWageHoursByEmployee(await loadWageTimeEntries(db, {
    orgId,
    employeePartyIds: rows.map((row) => String(row.employee_party_id)),
    periodStart: run.period_start,
    periodEnd: run.period_end,
    documentId,
  }));
  return rows.map((row) => ({
    ...row,
    approved_hours: wageHours.get(String(row.employee_party_id)) ?? "0",
  }));
}

/**
 * Which payroll country packs the org runs: the settings marker where it
 * exists, and for a tenant provisioned before the marker did, the packs whose
 * statutory components are actually seeded. NEVER a default of Canada — an
 * org that installed only the US pack must not be told to map CA slots, and a
 * third pack's org must not inherit anybody. Shared by the pay-run readiness
 * and the setup wizard so the two can never disagree about what is installed.
 */
export async function installedPayrollCountries(
  orgId: string,
  payrollBlob: Record<string, unknown>,
  allowedSubsidiaryIds?: PayrollSubsidiaryScope,
): Promise<string[]> {
  // Payroll pack markers are org-level configuration rooted at the active
  // root entity. A restricted caller may not use this aggregate when that
  // root is outside its explicit scope; an empty scope therefore denies it.
  if (allowedSubsidiaryIds != null) await payrollSettings(orgId, allowedSubsidiaryIds);
  if (Array.isArray((payrollBlob as { countries?: unknown }).countries)) {
    return ((payrollBlob as { countries: unknown[] }).countries).map(String);
  }
  return (await db.execute<{ country: string }>(sql`
    select distinct country from pay_components
     where org_id = ${orgId} and system_key is not null and country is not null
  `, "objects")).map((row) => row.country);
}

/** The tax year the org's business day falls in FOR THE PACK — never UTC `getFullYear()`. */
export const currentTaxYear = async (orgId: string, country: string): Promise<number> =>
  payrollTaxYearForDate(country, await businessToday(orgId)).taxYear;

/**
 * The org's active payroll population, reduced to the facts a scope point is
 * made of: country, region, and the filing identity the employee is paid under.
 * Used where there is no run to scope by (the setup state, the rates surface).
 */
/**
 * The regions and filing accounts the org's active payroll actually occupies.
 *
 * This selects only the columns the statutory-rate check reads. It used to
 * claim `ScopeRow[]`, which also declares `pay_basis`, `labour_jurisdiction`
 * and the per-run readiness flags — none of which this query selects, so those
 * fields were `undefined` behind a type that promised otherwise.
 */
export async function activePayrollPopulation(
  orgId: string,
  allowedSubsidiaryIds?: PayrollSubsidiaryScope,
): Promise<RateScopeRow[]> {
  const rows = (await db.execute<RateScopeRow>(sql`
    select p.id as employee_party_id, p.display_name as name, prof.country, prof.province,
           p.subsidiary_id, prof.residence_region,
           ${effectiveFilingAccountSql("prof")} as filing_account_id
     from employee_payroll_profiles prof
      join parties p on p.id = prof.employee_party_id and p.org_id = prof.org_id
     where prof.org_id = ${orgId} and prof.is_active
       ${payrollSubsidiaryScopeFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds)}
  `, "objects"));
  return rows;
}

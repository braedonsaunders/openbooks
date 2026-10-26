import { payrollEmploymentOverlapsPeriod } from "./employment-roster.ts";
import { sql, type SQL } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { PayrollError } from "./error.ts";
import { parsePayRunCalculationSource, payRunCalculationSource, payRunCalculationSourceChanges, payRunCalculationSourceDigest } from "./run-calculation-evidence.ts";
import { leavePayrollInputProblems } from "./leave-payroll-inputs.ts";
import { allowancePayrollInputProblem } from "./allowance-payroll-inputs.ts";
import { PERIODIC_RUN_TYPES } from "./run-contracts.ts";
import { payrollSubsidiaryScopeFilter, type PayrollSubsidiaryScope } from "./scope.ts";
import { PAYROLL_COUNTRY_PACKS } from "./packs.ts";
import { orgSettingsAuditAffectsCalculation } from "./settings-staleness.ts";
import { scope } from "./readiness-context.ts";

/** Pay-run staleness: inputs changed since calculation invalidate the calculated result. */

export interface PayRunStaleness {
  /** True when an input changed after the run was last calculated. */
  stale: boolean;
  /** Stable codes for what changed — see STALENESS_INPUT_CLASSES. */
  reasons: string[];
  calculatedAt: string | null;
}

/**
 * Every class of input a calculated stub is a function of. The wizard blocks
 * the commit while any of them changed after `calculated_at`, so anything
 * MISSING from this list is a silent commit of figures the operator edited
 * past — which is the one failure this control exists to prevent.
 *
 * `missing` is the run row itself: a run that cannot be read is not a fresh
 * run, and reporting it fresh green-lights a commit against nothing.
 */
export const STALENESS_INPUT_CLASSES = [
  "missing",
  "selection",
  "adjustments",
  "time",
  "wages",
  "schedule",
  "statutoryRates",
  "unionFringes",
  "roster",
  "components",
  "componentDefinitions",
  "compensationPackages",
  "derivedRules",
  "entitlements",
  "workerComp",
  "timeTypes",
  "items",
  "settings",
  "ytd",
  "openingBalances",
  "employerLevyYtd",
] as const;

/**
 * Whether the calculated stubs still reflect the run's inputs. Payroll's worst
 * failure mode is committing figures the operator edited past — so the wizard
 * reads this on every render and blocks the commit while it is stale, rather
 * than trusting anyone to remember to recalculate.
 *
 * The optional executor lets the COMMIT BOUNDARY ask the same question on its
 * own transaction's read (engine/src/payroll/run.ts) instead of trusting the
 * route to have asked it first; defaulting to the module connection keeps
 * every existing caller unchanged.
 */
/**
 * Whether an employee (a uuid text expression) is on pay run `r`: they have a
 * stub, or the last calculation recorded a refusal or warning for them. A
 * refused employee has no stub, and the remedy a refusal names — correcting
 * that employee's carry-ins — must still make the run stale so it can be
 * recalculated.
 */
function employeeOnRun(employeePartyId: SQL): SQL {
  return sql`(exists (select 1 from pay_stubs mine
                       where mine.org_id = r.org_id and mine.pay_run_document_id = r.document_id
                         and mine.employee_party_id::text = ${employeePartyId})
              or exists (select 1 from jsonb_array_elements(
                           case when jsonb_typeof(r.calculation_errors) = 'array'
                                then r.calculation_errors else '[]'::jsonb end) recorded
                          where recorded->>'employeePartyId' = ${employeePartyId}))`;
}

export async function payRunStaleness(
  orgId: string,
  documentId: string,
  executor: Pick<typeof db, "execute"> = db,
  allowedSubsidiaryIds?: PayrollSubsidiaryScope,
): Promise<PayRunStaleness> {
  const rows = (await executor.execute<{
      calculated_at: Date | string | null; never_calculated: boolean;
      run_type: string; period_start: string; period_end: string;
      calculation_source_snapshot: unknown; calculation_source_digest: string | null;
      adjustments_changed: boolean; assertions_changed: boolean; time_changed: boolean;
      wages_changed: boolean; schedule_changed: boolean; statutory_rates_changed: boolean;
      union_fringes_changed: boolean;
      roster_changed: boolean; employment_changed: boolean;
      components_changed: boolean; component_definitions_changed: boolean;
      derived_rules_changed: boolean; entitlements_changed: boolean;
      worker_comp_changed: boolean; time_types_changed: boolean;
      settings_changed: boolean; org_setting_changes: unknown[]; ytd_changed: boolean; opening_balances_changed: boolean;
    }>(sql`
    select r.calculated_at, r.calculation_source_snapshot, r.calculation_source_digest,
           r.run_type, r.period_start::text as period_start, r.period_end::text as period_end,
           r.calculated_at is null as never_calculated,
           exists (
             select 1 from pay_run_adjustments a
              where a.org_id = r.org_id and a.pay_run_document_id = r.document_id
                and a.updated_at > r.calculated_at) as adjustments_changed,
           -- Holiday assertions are the same kind of fact: per-run inputs
           -- filed after Calculate that the next pass reads fresh. Reported
           -- under "adjustments" deliberately — a dedicated reason string
           -- would touch all seven locales with live hsf translations,
           -- and the banner's remedy is identical (recalculate).
           exists (
             select 1 from pay_run_holiday_assertions ha
              where ha.org_id = r.org_id and ha.pay_run_document_id = r.document_id
                and ha.updated_at > r.calculated_at) as assertions_changed,
           exists (
             select 1 from time_entries t
              where t.org_id = r.org_id and t.status = 'approved'
                and t.worked_on between r.period_start and r.period_end
                and t.updated_at > r.calculated_at) as time_changed,
           exists (
             select 1 from labor_cost_rates w
              where w.org_id = r.org_id and w.updated_at > r.calculated_at) as wages_changed,
           -- The run's own pay calendar. calculateStub re-reads
           -- periods_per_year from it on every pass (factor P annualizes
           -- every statutory withholding), so a count corrected after
           -- Calculate restates the whole stub. Scoped to the run's schedule:
           -- another calendar's edit is not this run's news.
           exists (
             select 1 from pay_schedules sch
              where sch.org_id = r.org_id and sch.id = r.pay_schedule_id
                and sch.updated_at > r.calculated_at) as schedule_changed,
           -- Tenant-entered statutory rates: SUI/EHT rates, FUTA
           -- credit-reduction overrides, municipal rates. Both packs' configs
           -- read them fresh on every statutory pass, so an edit after
           -- Calculate restates the levies. Scoped to the countries on the
           -- run's schedule: a US rate edit is not a Canadian run's news.
           -- Pack-declared employer facts ride the same arm: an account-scoped employer
           -- multiple, the CNT exemption class and every other effective-dated
           -- fact are read fresh on every pass, so an edit after Calculate
           -- restates the stub exactly like a rate edit does.
           (exists (
             select 1 from payroll_statutory_rates sr
              where sr.org_id = r.org_id and sr.updated_at > r.calculated_at
                and exists (
                  select 1 from employee_payroll_profiles prof
                   where prof.org_id = r.org_id
                     and (prof.pay_schedule_id = r.pay_schedule_id or prof.pay_schedule_id is null)
                     and prof.is_active and prof.country = sr.country)
           )
           or exists (
             select 1 from payroll_employer_facts ef
              where ef.org_id = r.org_id and ef.updated_at > r.calculated_at
                and exists (
                  select 1 from employee_payroll_profiles prof
                   where prof.org_id = r.org_id
                     and (prof.pay_schedule_id = r.pay_schedule_id or prof.pay_schedule_id is null)
                     and prof.is_active and prof.country = ef.country)
           )) as statutory_rates_changed,
           -- Union agreements and fringe rates price stub lines fresh on
           -- every pass, and a pure rate change touches only the fringe row
           -- (the component-definition arm never fires). Scoped to the
           -- agreements on the run's schedule: another bargaining unit's new
           -- fringe is not this run's news.
           (exists (
              select 1 from union_fringes f
               where f.org_id = r.org_id and f.updated_at > r.calculated_at
                 and exists (
                   select 1 from employee_payroll_profiles prof
                    where prof.org_id = r.org_id
                      and (prof.pay_schedule_id = r.pay_schedule_id or prof.pay_schedule_id is null)
                      and prof.is_active and prof.union_agreement_id = f.agreement_id))
            or exists (
              select 1 from union_agreements a
               where a.org_id = r.org_id and a.updated_at > r.calculated_at
                 and exists (
                   select 1 from employee_payroll_profiles prof
                    where prof.org_id = r.org_id
                      and (prof.pay_schedule_id = r.pay_schedule_id or prof.pay_schedule_id is null)
                      and prof.is_active and prof.union_agreement_id = a.id)))
             as union_fringes_changed,
           -- Roster: the payroll profile (TD1/W-4, exemptions, schedule) and
           -- the employment record the run reads for termination, job title,
           -- trade and WCB class.
           exists (
             select 1 from employee_payroll_profiles prof
              where prof.org_id = r.org_id and (prof.pay_schedule_id = r.pay_schedule_id or prof.pay_schedule_id is null)
                and prof.updated_at > r.calculated_at)
           or exists(select 1 from employee_tax_certificates certificate
             join employee_payroll_profiles profile on profile.org_id=certificate.org_id and profile.employee_party_id=certificate.employee_party_id
             where certificate.org_id=r.org_id and profile.pay_schedule_id=r.pay_schedule_id
               and certificate.updated_at>r.calculated_at and (certificate.effective_from is null or certificate.effective_from<=r.pay_date)) as roster_changed,
           exists (
             select 1 from employee_roles er
              join employee_payroll_profiles prof
                on prof.org_id = er.org_id and prof.employee_party_id = er.party_id
              where er.org_id = r.org_id and (prof.pay_schedule_id = r.pay_schedule_id or prof.pay_schedule_id is null)
                and er.updated_at > r.calculated_at) as employment_changed,
           -- Per-employee assigned components: garnishments, benefits, RRSP,
           -- union dues overrides. Editing one of these changes net pay.
           exists (
             select 1 from employee_pay_components epc
              join employee_payroll_profiles prof
                on prof.org_id = epc.org_id and prof.employee_party_id = epc.employee_party_id
              where epc.org_id = r.org_id and (prof.pay_schedule_id = r.pay_schedule_id or prof.pay_schedule_id is null)
                and epc.updated_at > r.calculated_at) as components_changed,
           -- The component DEFINITIONS themselves (rate, taxability,
           -- pensionable/insurable flags, liability account), and the
           -- per-component department expense mapping: a mapping edited
           -- after Calculate restates the GL projection, which the line
           -- stamp froze at calculate time.
           (exists (
             select 1 from pay_components c
              where c.org_id = r.org_id and c.updated_at > r.calculated_at)
           or exists (
             select 1 from pay_component_department_expenses m
              where m.org_id = r.org_id and m.updated_at > r.calculated_at))
             as component_definitions_changed,
           exists (
             select 1 from pay_derived_rules dr
              where dr.org_id = r.org_id and dr.updated_at > r.calculated_at)
             as derived_rules_changed,
           -- Entitlement plans, their limits and their service tiers: all
           -- three move accrual and payout amounts on the stub. Plans, tiers
           -- and group-scoped limits apply to anyone they match, so any change
           -- stales the run; vacation terms, service credits and a limit set
           -- for one employee move only that employee's stub, so they stale
           -- the run only for an employee on it.
           (exists (select 1 from entitlement_plans ep
                     where ep.org_id = r.org_id and ep.updated_at > r.calculated_at)
            or exists (select 1 from entitlement_plan_limits el
                        where el.org_id = r.org_id and el.updated_at > r.calculated_at
                          and (el.employee_party_id is null or ${employeeOnRun(sql`el.employee_party_id::text`)}))
            or exists (select 1 from entitlement_service_tiers et
                        where et.org_id = r.org_id and et.updated_at > r.calculated_at)
            or exists (select 1 from payroll_vacation_terms vt
                         join worker_employments vte on vte.org_id = vt.org_id and vte.id = vt.employment_id
                        where vt.org_id = r.org_id and vt.updated_at > r.calculated_at
                          and ${employeeOnRun(sql`vte.worker_party_id::text`)})
            or exists (select 1 from payroll_service_credits sc
                         join worker_employments sce on sce.org_id = sc.org_id and sce.id = sc.employment_id
                        where sc.org_id = r.org_id and sc.updated_at > r.calculated_at
                          and ${employeeOnRun(sql`sce.worker_party_id::text`)})
            or exists (select 1 from audit_log al
                        where al.org_id = r.org_id and al.table_name = 'entitlement_service_tiers'
                          and al.at > r.calculated_at)
            -- Audited inserts, edits and deletions of an employee's terms or
            -- credits, scoped by the employment the audited row names.
            or exists (select 1 from audit_log al
                         join worker_employments ale on ale.org_id = al.org_id
                          and ale.id::text = coalesce(al.changes->'after'->>'employment_id', al.changes->'before'->>'employment_id')
                        where al.org_id = r.org_id and al.table_name in ('payroll_service_credits','payroll_vacation_terms')
                          and al.at > r.calculated_at
                          and ${employeeOnRun(sql`ale.worker_party_id::text`)}))
             as entitlements_changed,
           -- Pack-declared class rates and assessable maximums. calculatePayRun
           -- multiplies assessable earnings by worker_comp_groups.rate_percent
           -- to produce the employer premium, so a rate edited after Calculate
           -- commits a stale premium. The audit_log arm is belt AND braces on
           -- purpose: updated_at is now authoritative (the registry entry is
           -- flagged actorCols), but a writer that bypassed the generic setup
           -- route would still leave the audit row.
           (exists (select 1 from worker_comp_groups wcg
                     where wcg.org_id = r.org_id and wcg.updated_at > r.calculated_at)
            or exists (select 1 from audit_log al
                        where al.org_id = r.org_id and al.table_name = 'worker_comp_groups'
                          and al.at > r.calculated_at))
             as worker_comp_changed,
           -- Time-type definitions. calculatePayRun reads cost_multiplier as
           -- the wage multiplier and exclude_from_wages as the switch that
           -- keeps an event entry out of gross, so moving overtime from 1.5 to
           -- 2.0 after Calculate restates every overtime hour on the run.
           (exists (select 1 from time_types tt
                     where tt.org_id = r.org_id and tt.updated_at > r.calculated_at)
            or exists (select 1 from audit_log al
                        where al.org_id = r.org_id and al.table_name = 'time_types'
                          and al.at > r.calculated_at))
             as time_types_changed,
           -- Org settings are classified from their audit rows (see
           -- settings-staleness.ts): a posting-account edit does not change
           -- what a calculation computes, so the org row's audit evidence is
           -- read in TypeScript below rather than treated as a blanket change.
           -- An org update that no audit row covers is a write the audit
           -- trail cannot classify, so it stales the run.
           --
           -- The filing accounts a remittance is grouped under, and a
           -- calculation-time join reads them, so their edits stale the run.
           ((exists (select 1 from orgs o
                      where o.id = r.org_id and o.updated_at > r.calculated_at
                        and not exists (select 1 from audit_log cover
                                         where cover.org_id = o.id and cover.table_name = 'orgs'
                                           and cover.at >= o.updated_at)))
            or exists (select 1 from payroll_filing_accounts fa
                        where fa.org_id = r.org_id and fa.updated_at > r.calculated_at)
            or exists (select 1 from audit_log affiliation
                         where affiliation.org_id = r.org_id
                           and affiliation.table_name = 'payroll_us_filing_account_employer_lineage'
                           and affiliation.at > r.calculated_at))
             as settings_changed,
           (select coalesce(jsonb_agg(org_audit.changes), '[]'::jsonb)
              from audit_log org_audit
             where org_audit.org_id = r.org_id and org_audit.table_name = 'orgs'
               and org_audit.at > r.calculated_at) as org_setting_changes,
           -- Another run consumed this employee's statutory room. A run
           -- calculated before an off-cycle run commits carries the YTD the
           -- off-cycle run has already used, and over-deducts the employee past
           -- the contribution maximum (or under-deducts if that run was voided).
           exists (
             select 1 from pay_runs other
              where other.org_id = r.org_id and other.document_id <> r.document_id
                and other.tax_year = r.tax_year
                and other.run_status in ('committed', 'voided')
                and other.updated_at > r.calculated_at
                and exists (
                  select 1 from pay_stubs os
                   where os.org_id = r.org_id
                     and os.pay_run_document_id = other.document_id
                     and ${employeeOnRun(sql`os.employee_party_id::text`)})) as ytd_changed,
           -- Employer-scope carry-ins (payroll_employer_levy_opening, 0174) are
           -- the same fact at employer scope: pre-adoption base a declared
           -- aggregate levy prices its room against. Scoped to the countries
           -- on the run's schedule, like the statutory-rates arm above — a
           -- carry-in for a pack nobody on this run pays under is not this
           -- run's news. Reported under "openingBalances": it IS an opening
           -- balance edit.
           (exists (
             select 1 from payroll_employer_levy_opening eo
              where eo.org_id = r.org_id and eo.tax_year = r.tax_year
                and eo.updated_at > r.calculated_at
                and exists (
                  select 1 from employee_payroll_profiles prof
                   where prof.org_id = r.org_id
                     and (prof.pay_schedule_id = r.pay_schedule_id or prof.pay_schedule_id is null)
                     and prof.is_active and prof.country = eo.country))
            or exists (
             select 1 from audit_log al
              where al.org_id = r.org_id and al.table_name = 'payroll_employer_levy_opening'
                and al.at > r.calculated_at
                and (al.changes->>'taxYear')::int = r.tax_year
                and exists (select 1 from employee_payroll_profiles prof
                             where prof.org_id = r.org_id
                               and (prof.pay_schedule_id = r.pay_schedule_id or prof.pay_schedule_id is null)
                               and prof.is_active
                               and prof.country = al.changes->>'country'))) or
           -- Statutory carry-ins are the ONLY input for this year's annual
           -- ceilings (payroll-opening-balances.ts). A carry-in saved, changed
           -- or deleted for someone on the run after it was calculated makes
           -- the stub's social contributions a fiction; deletes leave no row
           -- to timestamp, so the save's audit evidence is watched as well.
           (exists (
             select 1 from audit_log prior_evidence
              where prior_evidence.org_id=r.org_id and prior_evidence.table_name='payroll_prior_earnings'
                and prior_evidence.at>r.calculated_at
                and ${employeeOnRun(sql`prior_evidence.changes->>'employeePartyId'`)})
            or exists (
             select 1 from payroll_opening_balances b
              where b.org_id = r.org_id and b.tax_year = r.tax_year
                and ${employeeOnRun(sql`b.employee_party_id::text`)}
                and (b.updated_at > r.calculated_at
                     or exists (select 1 from payroll_opening_balance_components oc
                                 where oc.org_id = b.org_id and oc.opening_balance_id = b.id
                                   and oc.updated_at > r.calculated_at)))
            or exists (
             select 1 from payroll_period_openings period_opening
              where period_opening.org_id=r.org_id and period_opening.tax_year=r.tax_year
                and period_opening.updated_at>r.calculated_at
                and ${employeeOnRun(sql`period_opening.employee_party_id::text`)})
            or exists (
             select 1 from payroll_opening_employer_authorities authority
              where authority.org_id=r.org_id and authority.tax_year=r.tax_year
                and authority.created_at>r.calculated_at
                and ${employeeOnRun(sql`authority.employee_party_id::text`)})
            or exists (
             select 1 from audit_log al
              where al.org_id = r.org_id and al.table_name = 'payroll_opening_balances'
                and al.at > r.calculated_at
                and (al.changes->>'taxYear')::int = r.tax_year
                and ${employeeOnRun(sql`al.changes->>'employeePartyId'`)}))
             as opening_balances_changed
      from pay_runs r
      join documents d on d.id = r.document_id and d.org_id = r.org_id
     where r.org_id = ${orgId} and r.document_id = ${documentId}
       ${payrollSubsidiaryScopeFilter(sql`d.subsidiary_id`, allowedSubsidiaryIds)}
  `, "objects"));
  const row = rows[0];
  // A missing run is not a fresh run. Fail closed and say why.
  if (!row) return { stale: true, reasons: ["missing"], calculatedAt: null };
  if (row.never_calculated) return { stale: false, reasons: [], calculatedAt: null };
  // Employer-aggregate room consumed elsewhere. The `ytd` arm above only
  // fires on a SHARED employee, so a committed run on a disjoint roster
  // sails past it while burning the same threshold allowance — the exact
  // over-consumption the commit-time levy fence serializes for. This arm is
  // the fence's other half: gated on a pack declaring per-run aggregate
  // levies for this year, so years without them behave exactly as before.
  // An org-setting audit row stales the run only when it changed something a
  // calculation reads (posting-account and control-account edits do not).
  const settingsChanged = row.settings_changed
    || row.org_setting_changes.some((changes) => orgSettingsAuditAffectsCalculation(changes));
  const employerLevyYtdChanged = await employerLevyRoomConsumed(
    orgId, documentId, executor, allowedSubsidiaryIds,
  );
  let selectionChanged = false;
  let exactCompensationPackagesChanged = false;
  let exactComponentsChanged = false;
  let exactTimeChanged = false;
  let exactTimeTypesChanged = false;
  let exactWagesChanged = false;
  let exactItemsChanged = false;
  let exactRosterChanged = false;
  let exactOpeningBalancesChanged = false;
  let exactIncomeTaxOverridesChanged = false;
  let exactBankCashInputsChanged = false;
  let exactLevyAdjustmentsChanged = false;
  let exactDeclaredVacationAccrualsChanged = false;
  let exactLeaveInputsChanged = false;
  let exactAllowanceInputsChanged = false;
  if (PERIODIC_RUN_TYPES.has(row.run_type)) {
    const parties = (await executor.execute<{ party_id: string }>(sql`
      select distinct employee_party_id::text as party_id
        from pay_stubs where org_id = ${orgId} and pay_run_document_id = ${documentId}
      union
      select distinct error->>'employeePartyId' as party_id
        from pay_runs r
        cross join lateral jsonb_array_elements(
          case when jsonb_typeof(r.calculation_errors) = 'array' then r.calculation_errors else '[]'::jsonb end
        ) error
       where r.org_id = ${orgId} and r.document_id = ${documentId}
         and error->>'employeePartyId' is not null
    `, "objects")).map((entry) => entry.party_id);
    const problem = await leavePayrollInputProblems(executor, {
      orgId,
      runDocumentId: documentId,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      employeePartyIds: parties,
    });
    exactLeaveInputsChanged = problem !== null;
    const allowanceProblem = await allowancePayrollInputProblem(executor, {
      orgId,
      runDocumentId: documentId,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      employeePartyIds: parties,
    });
    exactAllowanceInputsChanged = allowanceProblem !== null;
  }
  const storedSource = parsePayRunCalculationSource(row.calculation_source_snapshot);
  if (!storedSource || !row.calculation_source_digest
      || payRunCalculationSourceDigest(storedSource) !== row.calculation_source_digest) {
    selectionChanged = true;
  } else {
    const currentSource = await payRunCalculationSource(
      orgId, documentId, executor, false, allowedSubsidiaryIds,
    );
    if (!currentSource) {
      selectionChanged = true;
    } else if (payRunCalculationSourceDigest(currentSource) !== row.calculation_source_digest) {
      const changes = payRunCalculationSourceChanges(storedSource, currentSource);
      exactTimeChanged = changes.time;
      exactTimeTypesChanged = changes.timeTypes;
      exactWagesChanged = changes.wages;
      exactItemsChanged = changes.items;
      exactRosterChanged = changes.roster;
      exactOpeningBalancesChanged = changes.openingBalances;
      exactIncomeTaxOverridesChanged = changes.incomeTaxOverrides;
      exactBankCashInputsChanged = changes.bankCashInputs;
      exactLevyAdjustmentsChanged = changes.employerLevyAdjustments;
      exactDeclaredVacationAccrualsChanged = changes.declaredVacationAccruals;
      exactCompensationPackagesChanged = changes.compensationPackages;
      exactComponentsChanged = changes.components;
      selectionChanged = !changes.time && !changes.timeTypes && !changes.wages && !changes.items && !changes.compensationPackages && !changes.components && !changes.roster && !changes.openingBalances && !changes.incomeTaxOverrides && !changes.bankCashInputs && !changes.declaredVacationAccruals && !changes.employerLevyAdjustments;
    }
  }
  const reasons = [
    selectionChanged ? "selection" : null,
    row.adjustments_changed || row.assertions_changed || exactIncomeTaxOverridesChanged || exactBankCashInputsChanged || exactDeclaredVacationAccrualsChanged || exactLevyAdjustmentsChanged || exactAllowanceInputsChanged ? "adjustments" : null,
    row.time_changed || exactTimeChanged ? "time" : null,
    row.wages_changed || exactWagesChanged ? "wages" : null,
    row.schedule_changed ? "schedule" : null,
    row.statutory_rates_changed ? "statutoryRates" : null,
    row.union_fringes_changed ? "unionFringes" : null,
    row.roster_changed || row.employment_changed || exactRosterChanged ? "roster" : null,
    row.components_changed || exactComponentsChanged ? "components" : null,
    row.component_definitions_changed ? "componentDefinitions" : null,
    exactCompensationPackagesChanged ? "compensationPackages" : null,
    row.derived_rules_changed ? "derivedRules" : null,
    row.entitlements_changed || exactLeaveInputsChanged ? "entitlements" : null,
    row.worker_comp_changed ? "workerComp" : null,
    row.time_types_changed || exactTimeTypesChanged ? "timeTypes" : null,
    exactItemsChanged ? "items" : null,
    settingsChanged ? "settings" : null,
    row.ytd_changed ? "ytd" : null,
    row.opening_balances_changed || exactOpeningBalancesChanged ? "openingBalances" : null,
    employerLevyYtdChanged ? "employerLevyYtd" : null,
  ].filter((r): r is string => r !== null);
  return {
    stale: reasons.length > 0,
    reasons,
    calculatedAt: row.calculated_at instanceof Date
      ? row.calculated_at.toISOString()
      : (row.calculated_at ?? null),
  };
}

/**
 * Whether another run committed (or voided) employer-level room after this
 * run calculated. Two queries, both scoped narrow:
 *
 * 1. the run's tax year and the countries on its schedule — against which
 *    the pack declarations are read. A pack that refuses the year (nothing
 *    transcribed) contributes no levies here: the run could not have
 *    calculated any, and the refusal must not break the staleness answer
 *    for the inputs it did read;
 * 2. only when employer-level room is actually declared — a per-run
 *    aggregate levy, or the Phase-8 earnings-assessed employer levies (CA's
 *    EHT exemption is employer-level per province and consumes committed
 *    history only) — whether any OTHER run in the year committed or voided
 *    after this run calculated. No roster join: sharing no employee is
 *    exactly the case the `ytd` arm misses, and a shared roster already
 *    stales through it.
 *
 * This is the commit-time half of the committed-only doctrine: calculation
 * deliberately ignores uncommitted drafts, so without this arm two
 * disjoint-roster drafts could each claim the full exemption and both
 * commit cleanly. With it, the second commit refuses as stale
 * (`employerLevyYtd`) until it recalculates against the first run's
 * committed room.
 */
async function employerLevyRoomConsumed(
  orgId: string,
  documentId: string,
  executor: Pick<typeof db, "execute">,
  allowedSubsidiaryIds?: PayrollSubsidiaryScope,
): Promise<boolean> {
  const run = (await executor.execute<{
    tax_year: number; calculated_at: Date | string | null;
    period_start: string; period_end: string; run_type: string; pay_schedule_id: string; schedule_subsidiary_id: string | null;
  }>(sql`
    select r.tax_year, r.calculated_at, r.period_start::text as period_start, r.period_end::text as period_end, r.run_type,
           r.pay_schedule_id, s.subsidiary_id as schedule_subsidiary_id
      from pay_runs r
      join documents d on d.id = r.document_id and d.org_id = r.org_id
      join pay_schedules s on s.id = r.pay_schedule_id and s.org_id = r.org_id
     where r.org_id = ${orgId} and r.document_id = ${documentId}
       ${payrollSubsidiaryScopeFilter(sql`d.subsidiary_id`, allowedSubsidiaryIds)}
  `, "objects"));
  const info = run[0];
  if (!info || info.calculated_at === null) return false;
  // The run's affected employees: the population whose earnings claim room —
  // active schedule profiles, in the schedule's entity, excluding profiles
  // without recorded period coverage or scoped final-pay admission. Employees
  // outside this population neither claim room nor arm a country levy.
  const mine = await executor.execute<{
    employee_party_id: string; country: string; province: string | null;
  }>(sql`
    select prof.employee_party_id, prof.country, prof.province
      from employee_payroll_profiles prof
      join parties p on p.id = prof.employee_party_id and p.org_id = prof.org_id
      left join employee_roles er on er.party_id = p.id and er.org_id = prof.org_id
     where prof.org_id = ${orgId} and prof.pay_schedule_id = ${info.pay_schedule_id}
       and prof.is_active and prof.country is not null
       and ${payrollEmploymentOverlapsPeriod({
         org: sql`prof.org_id`, employee: sql`p.id`, employment: sql`prof.employment_id`,
         employer: sql`p.subsidiary_id`, hiredOn: sql`er.hired_on`, terminatedOn: sql`er.terminated_on`,
         periodStart: sql`${info.period_start}`, periodEnd: sql`${info.period_end}`,
         runType: sql`${info.run_type}`, document: sql`${documentId}`,
       })}
       and (${info.schedule_subsidiary_id}::uuid is null
        or p.subsidiary_id = ${info.schedule_subsidiary_id}::uuid)
  `, "objects");
  interface LevyArm {
    country: string;
    /** Phase-8 hook levies (CA EHT et al): employer room per province. */
    phase8: boolean;
    /** Declared base scope of a per-run aggregate levy. */
    regional: boolean;
    /** Per-employee caps are consumed only through shared employees. */
    perEmployeeCap: boolean;
    regions: string[];
    regionless: boolean;
    employees: string[];
  }
  const arms: LevyArm[] = [];
  for (const row of mine) {
    const pack = PAYROLL_COUNTRY_PACKS[row.country];
    if (!pack) continue;
    let arm = arms.find((a) => a.country === row.country && a.phase8 === (pack.applyEmployerLevies != null));
    if (!arm) {
      arm = {
        country: row.country,
        phase8: pack.applyEmployerLevies != null,
        regional: false,
        perEmployeeCap: false,
        regions: [],
        regionless: false,
        employees: [],
      };
      arms.push(arm);
    }
    if (row.province == null) arm.regionless = true;
    else if (!arm.regions.includes(row.province)) arm.regions.push(row.province);
    if (!arm.employees.includes(row.employee_party_id)) arm.employees.push(row.employee_party_id);
  }
  const declaredArms: LevyArm[] = [];
  for (const arm of arms) {
    const pack = PAYROLL_COUNTRY_PACKS[arm.country]!;
    if (arm.phase8) {
      // Phase-8 employer levies manage employer-level room outside the
      // aggregate channel (CA's EHT exemption), so the hook's presence
      // alone arms this check — no country branch, just the declared hook.
      declaredArms.push(arm);
      continue;
    }
    let levies: readonly {
      timing: string; base?: { scope?: string }; allowance?: { kind?: string };
    }[];
    try {
      levies = pack.employerAggregateLevies?.(info.tax_year) ?? [];
    } catch {
      // A pack that refuses the year contributes no levies here, as before.
      continue;
    }
    for (const levy of levies) {
      if (levy.timing !== "per_run") continue;
      declaredArms.push({
        ...arm,
        regional: levy.base?.scope === "region",
        perEmployeeCap: levy.allowance?.kind === "per_employee_cap",
      });
    }
  }
  if (declaredArms.length === 0) return false;
  const calculatedAt = info.calculated_at instanceof Date
    ? info.calculated_at.toISOString()
    : info.calculated_at;
  // Room truth is caller-independent (the engines read committed history
  // org-wide with no subsidiary predicate), so the consumer match is scoped
  // by what the engines actually share: the pack, the levy's aggregation
  // unit (the employer as a whole, or the employer in one region), and —
  // for per-employee caps — the affected employees. A US-pack run, a run
  // with no employee in the levy's unit, and a terminated roster share no
  // room with this run and never stale it.
  const armPredicates = declaredArms.map((arm) => sql`
    exists (
      select 1
        from employee_payroll_profiles oprof
        join parties op on op.id = oprof.employee_party_id and op.org_id = oprof.org_id
        join pay_schedules osch on osch.id = oprof.pay_schedule_id and osch.org_id = oprof.org_id
        left join employee_roles oer on oer.party_id = op.id and oer.org_id = oprof.org_id
       where oprof.org_id = ${orgId} and oprof.pay_schedule_id = other.pay_schedule_id
         and oprof.is_active and oprof.country = ${arm.country}
         and ${payrollEmploymentOverlapsPeriod({
           org: sql`oprof.org_id`, employee: sql`op.id`, employment: sql`oprof.employment_id`,
           employer: sql`op.subsidiary_id`, hiredOn: sql`oer.hired_on`, terminatedOn: sql`oer.terminated_on`,
           periodStart: sql`other.period_start`, periodEnd: sql`other.period_end`,
           runType: sql`other.run_type`, document: sql`other.document_id`,
         })}
         and (osch.subsidiary_id is null or op.subsidiary_id = osch.subsidiary_id)
         ${arm.regional || arm.phase8
           ? arm.regionless
             ? sql``
             : sql`and oprof.province in (${sql.join(arm.regions.map((r) => sql`${r}`), sql`, `)})`
           : sql``}
         ${arm.perEmployeeCap
           ? sql`and oprof.employee_party_id in (${sql.join(arm.employees.map((e) => sql`${e}`), sql`, `)})`
           : sql``}
    )
  `);
  const consumed = (await executor.execute<{ consumed: boolean }>(sql`
    select exists (
      select 1 from pay_runs other
       where other.org_id = ${orgId} and other.document_id <> ${documentId}
         and other.tax_year = ${info.tax_year}
         and other.run_status in ('committed', 'voided')
         and other.updated_at > ${calculatedAt}
         and (${sql.join(armPredicates, sql` or `)})
    ) as consumed
  `, "objects"));
  return consumed[0]!.consumed;
}

/**
 * The one refusal sentence for committing past a calculation — shared by the
 * API gate and the engine's own commit-time enforcement, so both boundaries
 * say exactly the same thing to the operator.
 */
export const staleCalculationMessage = (
  reasons: readonly string[],
  documentStatus: string | null = null,
): string => {
  const changed = reasons.map(reason => reason === "compensationPackages" ? "approved compensation terms" : reason).join(", ");
  // The remedy names the control the run's document state actually offers.
  // Calculation refuses any document that is not a draft, so an approved run
  // is recalculated through the approval withdrawal, and a run awaiting
  // approval must first have that approval decided or withdrawn.
  if (documentStatus === "approved") {
    return `the run's inputs changed after it was approved (${changed}) — recalculate the run from the pay run page to withdraw the approval and send it for approval again`;
  }
  if (documentStatus === "pending_approval") {
    return `the run's inputs changed after it was last calculated (${changed}) — the run is awaiting approval, so its approver must decide that request before the run can be recalculated`;
  }
  return `the run's inputs changed after it was last calculated (${changed}) — recalculate before committing`;
};

/**
 * The commit-side half of the staleness control.
 *
 * `payRunStaleness` is what the wizard RENDERS — a banner and a disabled
 * button, both client-side, both of which a scripted call to the runs API or
 * a tab left open across an edit simply walks past. This is the boundary
 * that ENFORCES it: called immediately before `commitPayRun`, it turns the
 * same answer into a refusal, so the figures the GL projection materializes
 * are always ones a calculation produced against the inputs as they stand
 * now — never ones the operator edited past after Calculate ran.
 *
 * The optional executor is how `commitPayRun` itself invokes this gate ON ITS
 * OWN TRANSACTION (engine/src/payroll/run.ts), so even an engine caller that
 * skips the route is refused, on the same snapshot the claim will run under.
 *
 * A missing run and a never-calculated run are NOT this gate's question to
 * answer: both fall through to `commitPayRun`'s own state guards ("pay run
 * not found", "calculate the pay run before committing"), which name those
 * states precisely. This gate owns exactly one question — is the stored
 * calculation still current — and answers it by refusing when it is not.
 */
export async function assertPayRunNotStale(
  orgId: string,
  documentId: string,
  executor: Pick<typeof db, "execute"> = db,
  allowedSubsidiaryIds?: PayrollSubsidiaryScope,
): Promise<void> {
  const { stale, reasons, calculatedAt } = await payRunStaleness(
    orgId, documentId, executor, allowedSubsidiaryIds,
  );
  if (!stale || calculatedAt === null) return;
  const status = (await executor.execute<{ status: string }>(sql`
    select status from documents where org_id = ${orgId} and id = ${documentId}
  `, "objects"))[0]?.status ?? null;
  throw new PayrollError(staleCalculationMessage(reasons, status));
}

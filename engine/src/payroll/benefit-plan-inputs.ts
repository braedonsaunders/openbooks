import { applyBasisCaps } from './limits.ts';
import { componentYearToDate } from './opening-balances.ts';
import { resolveWorkSchedule, scheduledHoursBetween } from './work-schedules.ts';
import { entitlementPlans, planBalanceExcludingRun } from './entitlements-db.ts';
import { computePlanMovement, type EntitlementMovement } from './entitlements-movement-kernel.ts';
import { sql } from 'drizzle-orm';
import type { db } from '../platform/db.ts';
import { parseMoney } from '../money/brands.ts';
import { add, sum, cmp } from '../money/money.ts';
import { canonicalJson } from './run-calculation-evidence.ts';
import { assignmentCoveredDays } from './assignment-windows.ts';
import { coveredPayrollLines } from './covered-payroll-lines.ts';
import { benefitCoverageWindow } from './benefit-coverage-window.ts';
import { PayrollError } from './error.ts';
import { cappableHourLines, programApplicabilityFromExclusions, type Line } from './run-stub-records.ts';
import { benefitCoverageRecoveryAmount, recurringBenefitAmount, type BenefitRecoveryLedgerEntry, type RecurringBenefitRule, type RecurringBenefitTerm, type BenefitContributionTier } from './benefit-plan-math.ts';
import { resolveEmploymentServiceCredit, meetsServiceYears, lockPayrollServiceConfiguration } from './service-credit.ts';

type Executor = Pick<typeof db, 'execute'>;
interface EnrollmentSource {
  id: string; planId: string; employerSubsidiaryId: string | null; currency: string; classKey: string | null; matchEligible: boolean | null;
  effectiveFrom: string; effectiveTo: string | null; planCode: string;
  terms: (RecurringBenefitTerm & { sourceDecimal: string | null; provenance: unknown })[];
  rules: (RecurringBenefitRule & { sourceDecimal: string | null; provenance: unknown;
    selectedComponentIds: string[]; selectedComponents: { id: string; kind: string; code: string; name: string }[] })[];
  tiers: (BenefitContributionTier & { classKey: string; effectiveFrom: string; effectiveTo: string | null })[];
  components: Record<string, unknown>[];
  recoveryPlans: Record<string, unknown>[];
  recoveryLedger: BenefitRecoveryLedgerEntry[];
  recoverySources: {id:string;ruleId:string;premiumRuleId:string}[];
}
export interface RecurringBenefitSource {
  employmentId: string; enrollments: EnrollmentSource[];
  currencyPrecisions: { code: string; minor_units: number }[];
  service: Awaited<ReturnType<typeof resolveEmploymentServiceCredit>> | null;
  workSchedule: Awaited<ReturnType<typeof resolveWorkSchedule>> | null;
}

/**
 * Read the same authoritative configuration for calculation and the commit
 * fence. Calculation serializes with configuration writers through the
 * transaction locks; `lock: false` is for read-only estimates, which read
 * one consistent snapshot and must never queue behind a running payroll.
 */
export async function recurringBenefitSource(tx: Executor, args: {
  orgId: string; employmentId: string; subsidiaryId: string | null; periodStart: string; periodEnd: string; payDate?: string; documentId?: string; lock?: boolean;
}): Promise<RecurringBenefitSource> {
  const { orgId, employmentId, periodStart, periodEnd, subsidiaryId } = args;
  const lock = args.lock !== false;
  if (lock) {
    await lockPayrollServiceConfiguration(tx, orgId);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`openbooks:benefit-recurring:${orgId}`},0))`);
  }
  const rows = (await tx.execute<{ source: EnrollmentSource }>(sql`
    select jsonb_build_object(
      'id',e.id,'planId',e.plan_id,'employerSubsidiaryId',p.employer_subsidiary_id,'currency',e.currency,'classKey',e.class_key,'matchEligible',e.match_eligible,
      'effectiveFrom',e.effective_from::text,'effectiveTo',e.effective_to::text,'planCode',p.code,
      'terms',coalesce((select jsonb_agg(jsonb_build_object(
        'id',t.id,'enrollmentId',t.enrollment_id,'ruleId',t.rule_id,'electionMode',t.election_mode,
        'electedRate',t.elected_rate::text,'declaredPeriodsPerYear',t.declared_periods_per_year,
        'effectiveFrom',t.effective_from::text,'effectiveTo',t.effective_to::text,
        'overrideReason',t.override_reason,'overrideApprovedBy',t.override_approved_by,'overrideApprovedAt',t.override_approved_at,
        'sourceDecimal',t.source_decimal,'provenance',t.provenance) order by t.id)
        from hrm_benefit_enrollment_terms t where t.org_id=e.org_id and t.enrollment_id=e.id
        and t.effective_from<=${periodEnd}::date and (t.effective_to is null or t.effective_to>=${periodStart}::date)),'[]'::jsonb),
      'rules',coalesce((select jsonb_agg(jsonb_build_object(
        'id',r.id,'planId',r.plan_id,'ruleKey',r.rule_key,'name',r.name,'kind',r.kind,'payComponentId',r.pay_component_id,
        'basis',r.basis,'rate',r.rate::text,'rateFormula',r.rate_formula,'hoursBasis',r.hours_basis,'hoursCoverage',r.hours_coverage,'payBasis',r.pay_basis,
        'selectedComponentIds',coalesce((select jsonb_agg(rc.pay_component_id order by rc.pay_component_id)
          from hrm_benefit_contribution_rule_components rc where rc.org_id=r.org_id and rc.rule_id=r.id),'[]'::jsonb),
        'selectedComponents',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'kind',c.kind,'code',c.code,'name',c.name) order by c.code)
          from hrm_benefit_contribution_rule_components rc join pay_components c on c.org_id=rc.org_id and c.id=rc.pay_component_id
          where rc.org_id=r.org_id and rc.rule_id=r.id),'[]'::jsonb),
        'runApplicability',r.run_applicability,'unpaidPeriodTreatment',r.unpaid_period_treatment,'arrearsPlanId',r.arrears_plan_id,'arrearsRecoveryPeriods',r.arrears_recovery_periods,
        'monthsPerYear',r.months_per_year,'periodsPerYear',r.periods_per_year,'proration',r.proration,'matchRuleId',r.match_rule_id,
        'requiresMatchEligibility',r.requires_match_eligibility,'enforcePolicyCap',r.enforce_policy_cap,'position',r.position,
        'effectiveFrom',r.effective_from::text,'effectiveTo',r.effective_to::text,'sourceDecimal',r.source_decimal,'provenance',r.provenance)
        order by r.position,r.id) from hrm_benefit_contribution_rules r where r.org_id=p.org_id and r.plan_id=p.id
        and r.is_active and r.effective_from<=${periodEnd}::date and (r.effective_to is null or r.effective_to>=${periodStart}::date)),'[]'::jsonb),
      'tiers',coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'classKey',t.class_key,
        'minimumServiceYears',t.minimum_service_years,'employerMaxPercent',t.employer_max_percent::text,'employeeMatchRatio',t.employee_match_ratio::text,
        'effectiveFrom',t.effective_from::text,'effectiveTo',t.effective_to::text) order by t.minimum_service_years,t.id)
        from hrm_benefit_contribution_tiers t where t.org_id=p.org_id and t.plan_id=p.id and t.class_key=e.class_key
        and t.effective_from<=${periodEnd}::date and (t.effective_to is null or t.effective_to>=${periodEnd}::date)),'[]'::jsonb),
      'recoverySources',coalesce((select jsonb_agg(jsonb_build_object('id',rs.id,'ruleId',rs.rule_id,'premiumRuleId',rs.premium_rule_id) order by rs.id) from hrm_benefit_recovery_sources rs where rs.org_id=p.org_id and rs.plan_id=p.id),'[]'::jsonb),
      'recoveryLedger',coalesce((select jsonb_agg(jsonb_build_object('id',l.id,'planId',l.plan_id,'documentId',l.pay_run_document_id,'movementDate',l.movement_date::text,'kind',l.kind,'amount',l.amount::text) order by l.movement_date,l.id) from entitlement_ledger l where l.org_id=e.org_id and l.employee_party_id=w.worker_party_id and l.movement_date<=${args.payDate ?? periodEnd}::date and l.pay_run_document_id is distinct from ${args.documentId ?? null}::uuid and l.plan_id in (select r.arrears_plan_id from hrm_benefit_contribution_rules r where r.org_id=p.org_id and r.plan_id=p.id)),'[]'::jsonb),
      'recoveryPlans',coalesce((select jsonb_agg(to_jsonb(ep) || jsonb_build_object('accrual_value',ep.accrual_value::text) order by ep.id) from entitlement_plans ep
        where ep.org_id=p.org_id and ep.id in (select r.arrears_plan_id from hrm_benefit_contribution_rules r where r.org_id=p.org_id and r.plan_id=p.id)),'[]'::jsonb),
      'components',coalesce((select jsonb_agg(to_jsonb(c) || jsonb_build_object('value',c.value::text,'basis_cap_hours_per_period',c.basis_cap_hours_per_period::text,'basis_cap_amount_per_period',c.basis_cap_amount_per_period::text,'basis_cap_amount_per_year',c.basis_cap_amount_per_year::text,'protection_max_percent',c.protection_max_percent::text,'supplemental_wage_category',ec.supplemental_wage_category,
        'statutory_reporting_category',ec.statutory_reporting_category,'statutory_exemption_category',ec.statutory_exemption_category) order by c.id)
        from pay_components c left join pay_component_earning_classifications ec on ec.org_id=c.org_id and ec.pay_component_id=c.id
        where c.org_id=p.org_id and c.id in (select r.pay_component_id from hrm_benefit_contribution_rules r where r.org_id=p.org_id and r.plan_id=p.id)),'[]'::jsonb)
    ) as source from hrm_benefit_enrollments e join hrm_benefit_plans p on p.org_id=e.org_id and p.id=e.plan_id
    join worker_employments w on w.org_id=e.org_id and w.id=e.employment_id
    where e.org_id=${orgId} and e.employment_id=${employmentId} and e.status in ('active','ended')
    and e.effective_from<=${periodEnd}::date and (e.effective_to is null or e.effective_to>=${periodStart}::date)
    and w.employer_subsidiary_id is not distinct from ${subsidiaryId}::uuid
    order by e.id
  `)).rows.map(row => row.source);
  const needsService = rows.some(e => e.rules.some(r => r.enforcePolicyCap || r.rateFormula !== 'elected_rate'));
  const service = needsService ? await resolveEmploymentServiceCredit(tx, { orgId, employmentId, asOf: periodEnd, lock }) : null;
  let workSchedule: Awaited<ReturnType<typeof resolveWorkSchedule>> | null = null;
  if (rows.some(e => e.rules.some(r => r.hoursBasis === 'scheduled_paid'))) {
    const subject = (await tx.execute<{ worker_party_id: string }>(sql`select worker_party_id from worker_employments where org_id=${orgId} and id=${employmentId}`)).rows[0];
    if (subject) workSchedule = await resolveWorkSchedule(tx, orgId, subject.worker_party_id, periodEnd);
  }
  const currencies = [...new Set(rows.map(e => e.currency))].sort();
  const currencyCodes = sql`array[${sql.join(currencies.map(code => sql`${code}`), sql`, `)}]::text[]`;
  const currencyPrecisions = currencies.length ? (await tx.execute<{ code: string; minor_units: number }>(sql`
    select code,minor_units from currencies where code=any(${currencyCodes}) order by code ${lock ? sql`for share` : sql``}
  `)).rows : [];
  return { employmentId, enrollments: rows, currencyPrecisions, service, workSchedule };
}

function coveredBaseLines(lines: readonly Line[], from: string, to: string, periodStart: string, periodEnd: string): Line[] {
  return coveredPayrollLines(lines.filter(l => l.kind === 'earning' && !l.accrualOnly && l.paymentKind !== 'non_cash'),
    from, to, periodStart, periodEnd);
}

/** Native lines land before statutory calculation; allocations preserve the exact elected source. */
export async function appendRecurringBenefitLines(tx: Executor, args: {
  orgId: string; actorId: string; documentId: string; employmentId: string; employeePartyId: string;
  subsidiaryId: string | null; currency: string; country: string; periodStart: string; periodEnd: string;
  stage: "vacationable_earnings" | "remaining"; regularCashLines: readonly Line[];
  periodsPerYear: number; hourlyWage: string | null; payBasis: string; payDate: string; taxYear: number; runType: string; oneOffRun: boolean; simulate: boolean; lines: Line[]; entitlementMovements: EntitlementMovement[];
}): Promise<void> {
  const source = await recurringBenefitSource(tx, args);
  const originalLines = args.lines.slice();
  const nativePlans = source.enrollments.some(e => e.rules.some(r => r.arrearsPlanId !== null)) ? await entitlementPlans(args.orgId, tx) : [];
  const recoveryOwners=new Set<string>();
  for (const enrollment of source.enrollments) {
    if (enrollment.employerSubsidiaryId !== null && enrollment.employerSubsidiaryId !== args.subsidiaryId) throw new PayrollError(`Benefit plan ${enrollment.planCode} belongs to another legal entity — end the mismatched enrollment and elect a plan available to the employee employer`);
    if (enrollment.currency !== args.currency) throw new PayrollError(`Benefit plan ${enrollment.planCode} is in ${enrollment.currency}, while payroll pays ${args.currency} — elect a plan in the pay-run currency; contributions never guess an exchange rate`);
    const currencyMinorUnits = source.currencyPrecisions.find(c => c.code === enrollment.currency)?.minor_units;
    if (currencyMinorUnits === undefined) throw new PayrollError(`Benefit plan ${enrollment.planCode} has no registered payable precision for ${enrollment.currency} — configure its currency before calculating payroll`);
    if (!enrollment.rules.length) throw new PayrollError(`Benefit plan ${enrollment.planCode} has no effective contribution rules — configure its Contributions for the pay period before calculating payroll`);
    if (!enrollment.terms.length && enrollment.rules.length) throw new PayrollError(`Benefit plan ${enrollment.planCode} has no contribution election terms — record the employee elections before calculating payroll`);
    for (const term of enrollment.terms) {
      const rule = enrollment.rules.find(r => r.id === term.ruleId);
      if (!rule) throw new PayrollError(`Benefit plan ${enrollment.planCode} election names an inactive or out-of-date rule — end the election terms or provide an effective replacement rule`);
      if (args.runType !== 'regular' && rule.runApplicability === 'regular_only') continue;
      const coverage = benefitCoverageWindow({ rule, enrollment, term, periodStart: args.periodStart, periodEnd: args.periodEnd });
      if (coverage === null) continue;
      const { from, to, earningsFrom, earningsTo } = coverage;
      if (rule.arrearsPlanId !== null) {
        if (recoveryOwners.has(rule.arrearsPlanId)) throw new PayrollError(`Benefit recovery bank has more than one covered policy term in this pay period — make its successor election effective at the next pay-period boundary`);
        recoveryOwners.add(rule.arrearsPlanId);
      }
      const component = enrollment.components.find(c => String(c.id) === rule.payComponentId);
      const requiredKind = rule.kind === 'employee_deduction' ? 'deduction' : ['taxable_non_cash','cash_earning'].includes(rule.kind) ? 'earning' : 'employer_contribution';
      if (!component || !component.is_active || component.kind !== requiredKind || component.system_key != null ||
          component.country != null && component.country !== args.country ||
          rule.kind === 'taxable_non_cash' && (component.payment_kind !== 'non_cash' || component.taxable !== true) ||
          rule.kind === 'cash_earning' && component.payment_kind !== 'cash') {
        throw new PayrollError(`Benefit rule ${rule.ruleKey} requires an active ${requiredKind}${rule.kind === 'taxable_non_cash' ? ' with taxable non-cash treatment' : rule.kind === 'cash_earning' ? ' with cash treatment' : ''} component for ${args.country} — correct the linked payroll component`);
      }
      const vacationableEarning = requiredKind === 'earning' && component.vacationable === true;
      if (vacationableEarning && rule.basis === 'percent_of_eligible_pay' && rule.payBasis === 'all_cash_earnings') {
        throw new PayrollError(`Benefit rule ${rule.ruleKey} creates a circular vacation-pay basis — choose regular cash earnings, which excludes derived vacation pay, or use an independent hourly or fixed-period premium`);
      }
      if ((args.stage === 'vacationable_earnings') !== vacationableEarning) continue;
      if (rule.kind === 'cash_earning' && originalLines.some(line => line.componentId === rule.payComponentId && cmp(line.amount,'0') !== 0)) {
        throw new PayrollError(`Benefit rule ${rule.ruleKey} also has a supplied earning for its output component — retain the existing input or the approved Benefits election as the sole source before recalculating; cash incentives are never added twice`);
      }
      const duplicate = (await tx.execute<{ id: string }>(sql`select id from employee_pay_components where org_id=${args.orgId}
        and employee_party_id=${args.employeePartyId} and component_id=${rule.payComponentId} and is_active
        and (employment_id is null or employment_id=${args.employmentId}) and effective_from<=${to}::date
        and (effective_to is null or effective_to>=${from}::date) limit 1`)).rows[0];
      if (duplicate) throw new PayrollError(`Benefit rule ${rule.ruleKey} also has a recurring payroll component assignment — end that duplicate assignment so the Benefits election remains the contribution source`);
      const baseLines = coveredBaseLines(originalLines, earningsFrom, earningsTo, args.periodStart, args.periodEnd);
      if (rule.hoursBasis === 'scheduled_paid' && args.payBasis === 'salary' && !args.oneOffRun) {
        const scheduled = source.workSchedule ? scheduledHoursBetween(source.workSchedule, earningsFrom, earningsTo) : null;
        if (scheduled === null) throw new PayrollError(`Benefit rule ${rule.ruleKey} needs the employee's scheduled paid hours — configure a native work schedule before calculating`);
        const salaryLine = baseLines.find(l => l.description === 'Salary');
        if (!salaryLine) throw new PayrollError(`Benefit rule ${rule.ruleKey} has no paid salary earnings — use actual paid hours or correct the salary inputs`);
        salaryLine.hours = scheduled;
      }
      const regular = (line: Line) => !['overtime','double_time'].includes(line.classification ?? '') && !line.nonPeriodic;
      // A counted component list names earning components by id — never a
      // country, a code, or a kind the generic layer would have to interpret.
      // Quantity-based units (trips, meals, incentive units) carry no stub
      // hours, so listing one matches nothing; a listed deduction or
      // contribution is refused by name instead of silently under-counting.
      if (rule.hoursBasis === 'selected_components') {
        if (rule.selectedComponentIds?.includes(rule.payComponentId)) throw new PayrollError(`Benefit rule ${rule.ruleKey} counts its own output — select original earning components in its Counted components before calculating`);
        for (const selected of rule.selectedComponents ?? []) {
          if (selected.kind !== 'earning') throw new PayrollError(`Benefit rule ${rule.ruleKey} counts ${selected.code} (${selected.name}), which is not an earning component — list only earning components whose hours count`);
        }
        if ((rule.selectedComponentIds?.length ?? 0) === 0) throw new PayrollError(`Benefit rule ${rule.ruleKey} counts selected components but none are listed — list the earning components whose hours count in Benefits → Contribution rules`);
      }
      const selected = rule.hoursBasis === 'selected_components' ? new Set(rule.selectedComponentIds ?? []) : null;
      const hourLines = rule.hoursBasis === 'regular_paid' ? baseLines.filter(regular)
        : selected !== null ? baseLines.filter(l => l.componentId !== null && selected.has(l.componentId)) : baseLines;
      const payLines = rule.payBasis === 'regular_cash_earnings'
        ? coveredBaseLines(args.regularCashLines, earningsFrom, earningsTo, args.periodStart, args.periodEnd).filter(regular) : baseLines;
      const tier = source.service ? enrollment.tiers.filter(t => meetsServiceYears(source.service!, t.minimumServiceYears)).at(-1) ?? null : null;
      const matchingTerm = enrollment.terms.find(t => t.ruleId === rule.matchRuleId && t.effectiveFrom <= from && (t.effectiveTo === null || t.effectiveTo >= to));
      const basis = { hours: sum(hourLines.map(l => l.hours ?? '0')), eligiblePay: sum(payLines.map(l => l.amount)), hourlyWage: args.hourlyWage,
        periodsPerYear: args.periodsPerYear, currencyMinorUnits, ...assignmentCoveredDays({ effectiveFrom: from, effectiveTo: to, periodStart: args.periodStart, periodEnd: args.periodEnd }),
        matchEligible: enrollment.matchEligible, tier, matchingElectedRate: matchingTerm?.electionMode === 'fixed' ? matchingTerm.electedRate : null };
      let result = recurringBenefitAmount(rule, term, basis);
      const cap = { basis: rule.basis === 'per_hour' ? 'per_hour' as const : rule.basis === 'percent_of_eligible_pay' ? 'percent_of_gross' as const : 'fixed_amount' as const,
        value: result.rate, basisCapHoursPerPeriod: component.basis_cap_hours_per_period as string | null,
        basisCapAmountPerPeriod: component.basis_cap_amount_per_period as string | null, basisCapAmountPerYear: component.basis_cap_amount_per_year as string | null };
      if (cap.basisCapHoursPerPeriod != null || cap.basisCapAmountPerPeriod != null || cap.basisCapAmountPerYear != null) {
        const capped = applyBasisCaps(cap, rule.basis === 'per_hour' ? basis.hours : rule.basis === 'percent_of_eligible_pay' ? basis.eligiblePay : result.amount, {
          currencyMinorUnits, lines: cappableHourLines(hourLines), yearToDate: cap.basisCapAmountPerYear == null ? '0' : await componentYearToDate(tx, {
            orgId: args.orgId,employeePartyId: args.employeePartyId,taxYear: args.taxYear,componentId: rule.payComponentId,excludeRunDocumentId: args.documentId }) });
        if (rule.basis === 'per_hour') { basis.hours = capped; result = recurringBenefitAmount(rule, term, basis); }
        else if (rule.basis === 'percent_of_eligible_pay') { basis.eligiblePay = capped; result = recurringBenefitAmount(rule, term, basis); }
        else result = { ...result, amount: parseMoney(capped) };
      }
      if (cmp(result.amount, '0') < 0) {
        throw new PayrollError(`Benefit rule ${rule.ruleKey} produces a negative contribution — review its counted earning components and signed bank inputs before calculating; contribution allocations must be non-negative`);
      }
      const coverageAmount = result.amount;
      const recoverySources=enrollment.recoverySources.filter(s=>s.ruleId===rule.id);
      const insuredPremiums=recoverySources.map(source=>{
        const premiumRule=enrollment.rules.find(r=>r.id===source.premiumRuleId);
        if (!premiumRule || !['employer_contribution','taxable_non_cash'].includes(premiumRule.kind) || !['per_period','per_month','per_year'].includes(premiumRule.basis)) throw new PayrollError(`Benefit recovery ${rule.ruleKey} has no effective linked employer premium — correct its Recovery sources`);
        const premiumTerms=enrollment.terms.filter(t=>t.ruleId===premiumRule.id);
        if (!premiumTerms.length) throw new PayrollError(`Benefit recovery ${rule.ruleKey} has no election for premium ${premiumRule.ruleKey} — record the insured premium election`);
        const amount=sum(premiumTerms.map(premiumTerm=>{
          const premiumFrom=[from,premiumRule.effectiveFrom,premiumTerm.effectiveFrom].sort().at(-1)!;
          const premiumTo=[to,premiumRule.effectiveTo,premiumTerm.effectiveTo].filter((v):v is string=>v!==null).sort()[0]!;
          return premiumFrom>premiumTo ? '0' : recurringBenefitAmount(premiumRule,premiumTerm,{...basis,...assignmentCoveredDays({effectiveFrom:premiumFrom,effectiveTo:premiumTo,periodStart:args.periodStart,periodEnd:args.periodEnd})}).amount;
        }));
        return {source,rule:premiumRule,terms:premiumTerms,amount};
      });
      const insuredCoverageAmount=sum([coverageAmount,...insuredPremiums.map(p=>p.amount)]);
      const unpaid = cmp(sum(baseLines.map(l => l.amount)), '0') <= 0;
      if (rule.unpaidPeriodTreatment === 'carry') {
        if (rule.arrearsPlanId !== null) {
          const recovery = nativePlans.find(p => p.id === rule.arrearsPlanId);
          if (!recovery || recovery.unit !== 'money' || recovery.direction !== 'owe' || recovery.accrualMethod !== 'manual' || recovery.accrualValue !== null || recovery.payoutComponentId !== rule.payComponentId || !rule.arrearsRecoveryPeriods) {
            throw new PayrollError(`Benefit rule ${rule.ruleKey} needs its active native money owe bank, matching deduction component, and declared recovery periods — correct the recovery policy`);
          }
          const opening = await planBalanceExcludingRun(tx, args.orgId, recovery.id, args.employeePartyId, args.payDate, args.documentId);
          const recoveryResult = computePlanMovement({ plan: recovery, employeePartyId: args.employeePartyId, movementDate: args.payDate, openingBalance: opening,
            earnings: basis.eligiblePay, hours: basis.hours, limit: null, unpaidCoverageValue: unpaid ? insuredCoverageAmount : null,
            scheduledRepaymentValue: unpaid ? null : benefitCoverageRecoveryAmount(enrollment.recoveryLedger.filter(l=>l.planId===recovery.id),rule.arrearsRecoveryPeriods) });
          args.entitlementMovements.push(...recoveryResult.movements);
          const repayment = sum(recoveryResult.movements.filter(m => m.kind === 'repayment').map(m => m.amount));
          result = { ...result, amount: parseMoney(unpaid ? '0' : add(coverageAmount, repayment)) };
        } else if (unpaid) {
          if (rule.kind === 'employee_deduction' && cmp(coverageAmount,'0') > 0) throw new PayrollError(`Benefit rule ${rule.ruleKey} carries unpaid deductions but has no recovery bank — configure its native owe plan and recovery periods`);
          result = { ...result, amount: parseMoney('0') };
        }
      }
      const benefitLine: Line | null = cmp(result.amount, '0') !== 0 ? {
        entitlementMovementKey: rule.arrearsPlanId !== null ? `${rule.arrearsPlanId}:repayment` : undefined,
        componentId: rule.payComponentId, kind: requiredKind, description: `${enrollment.planCode}: ${rule.name}`,
        amount: result.amount, rate: result.rate, paymentKind: component.payment_kind as Line['paymentKind'], nonCashAccountId: component.non_cash_account_id as string | null,
        // The source hours are already paid on their original earning lines.
        // A cash incentive values those hours without creating worked hours
        // again for insurability, pension contributions or entitlement banks.
        hours: rule.basis === 'per_hour' && rule.kind !== 'cash_earning' ? basis.hours : undefined,
        earnedFrom: from, earnedTo: to, sequence: Number(component.sequence),
        taxable: component.taxable as boolean, pensionable: component.pensionable as boolean, insurable: component.insurable as boolean,
        vacationable: component.vacationable as boolean, nonPeriodic: component.non_periodic as boolean,
        taxTreatment: component.tax_treatment as string, programApplicability: programApplicabilityFromExclusions(component.program_exclusions),
        supplementalWageCategory: component.supplemental_wage_category as Line['supplementalWageCategory'],
        statutoryReportingCategory: component.statutory_reporting_category as string | null,
        statutoryExemptionCategory: component.statutory_exemption_category as Line['statutoryExemptionCategory'],
        protectionBase: component.protection_base as string, protectionMaxPercent: component.protection_max_percent as string | null,
        protectionPriority: Number(component.protection_priority ?? 100), protectionClass: (component.protection_class as string | null) ?? null, includeInDisposableEarnings: component.include_in_disposable_earnings as boolean,
      } : null;
      if (benefitLine) args.lines.push(benefitLine);
      if (!args.simulate) {
        const inserted = (await tx.execute<{ id: string }>(sql`insert into pay_run_benefit_allocations
          (org_id,pay_run_document_id,employment_id,employee_party_id,enrollment_id,rule_id,term_id,period_from,period_to,amount,currency,source_snapshot,created_by,updated_by)
          values (${args.orgId},${args.documentId},${args.employmentId},${args.employeePartyId},${enrollment.id},${rule.id},${term.id},${from}::date,${to}::date,
          ${result.amount},${args.currency},${JSON.stringify({ rule, term, coverage, basis, result, coverageAmount, insuredCoverageAmount, insuredPremiums, component, service: source.service?.sourceSnapshot ?? null })}::jsonb,${args.actorId},${args.actorId}) returning id`)).rows;
        if (inserted.length !== 1) throw new PayrollError(`Benefit rule ${rule.ruleKey} was not recorded — retry calculation; a payable contribution must carry its allocation evidence`);
        if (benefitLine) benefitLine.benefitAllocationId = inserted[0]!.id;
      }
    }
  }
}

export async function recurringBenefitsRunSource(tx: Executor, orgId: string, documentId: string, lock = false): Promise<RecurringBenefitSource[]> {
  const run = (await tx.execute<{ period_start: string; period_end: string; pay_date: string; subsidiary_id: string | null; run_type: string }>(sql`
    select r.period_start::text,r.period_end::text,r.pay_date::text,d.subsidiary_id,r.run_type from pay_runs r join documents d on d.org_id=r.org_id and d.id=r.document_id
    where r.org_id=${orgId} and r.document_id=${documentId}`)).rows[0];
  if (!run) throw new PayrollError('pay run not found');
  const subjects = (await tx.execute<{ employment_id: string }>(sql`select employment_id from pay_stubs
    where org_id=${orgId} and pay_run_document_id=${documentId} order by employment_id`)).rows;
  const source: RecurringBenefitSource[] = [];
  for (const subject of subjects) source.push(await recurringBenefitSource(tx, { orgId, employmentId: subject.employment_id,
    subsidiaryId: run.subsidiary_id, periodStart: run.period_start, periodEnd: run.period_end, payDate: run.pay_date, documentId, lock }));
  return source;
}

export async function assertRecurringBenefitsRunFresh(tx: Executor, orgId: string, documentId: string, stored: unknown): Promise<void> {
  const current = await recurringBenefitsRunSource(tx, orgId, documentId, true);
  if (!Array.isArray(stored) || canonicalJson(current) !== canonicalJson(stored)) {
    throw new PayrollError('Benefit contribution elections, policy, service, currency precision, or payroll component treatment changed after calculation — recalculate the pay run before committing');
  }
}

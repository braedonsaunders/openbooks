import { sql } from 'drizzle-orm';
import { canonicalDecimal, compareDecimal } from '../../money/exact-decimal.ts';
import { decimalNullRefusal } from '../../money/decimal-refusal.ts';
import type { RecurringBenefitRule, RecurringBenefitTerm } from '../../payroll/benefit-plan-math.ts';
import { HrmAuthorizationError, requireHrmBenefitsManageOnEmployment } from '../authorization.ts';
import { BenefitsError } from './errors.ts';
import { assertHrmEnabled, db, withOrgTransaction, requireActorId, requireOrgId, requireId, requireCivilDate, requireOneRow, type SqlExecutor } from './shared.ts';

export type BenefitContributionConfigurationEntity = 'benefit-contribution-rules' | 'benefit-contribution-classes' | 'benefit-contribution-tiers' | 'benefit-recovery-sources' | 'benefit-enrollment-terms';
export type { RecurringBenefitRule, RecurringBenefitTerm };
const refuse = (message: string): never => { throw new BenefitsError('REFUSED', message); };
function decimal(body: Record<string, unknown>, field: string, required = true): string | null {
  if (!required && (body[field] == null || body[field] === '')) return null;
  const value = canonicalDecimal(body[field], 10);
  if (value === null) refuse(decimalNullRefusal(field, 'contribution rate', body[field], 10));
  if (compareDecimal(value!, '0') < 0) refuse(`${field} must be non-negative — record a non-negative exact decimal rate`);
  return value;
}
function dates(body: Record<string, unknown>): { from: string; to: string | null } {
  const from = requireCivilDate(body.effectiveFrom, 'effectiveFrom');
  const to = body.effectiveTo == null || body.effectiveTo === '' ? null : requireCivilDate(body.effectiveTo, 'effectiveTo');
  if (to !== null && to < from) refuse('Contribution dates are reversed — end the term on or after its start');
  return { from, to };
}

/** Shared integrity seam for native Setup writes and election commands. Parent locks fence payroll commit. */
export async function validateBenefitContributionConfiguration(exec: SqlExecutor, orgId: string, entity: BenefitContributionConfigurationEntity, body: Record<string, unknown>): Promise<void> {
  if (entity === 'benefit-enrollment-terms') {
    const enrollmentId = requireId(body.enrollmentId, 'enrollmentId');
    const ruleId = requireId(body.ruleId, 'ruleId');
    const reference = requireOneRow((await exec.execute<{ plan_id: string; effective_from: string; effective_to: string | null; status: string; submission_snapshot: unknown; rule_plan_id: string }>(sql`
      select e.plan_id,e.effective_from::text,e.effective_to::text,e.status,e.submission_snapshot,r.plan_id as rule_plan_id from hrm_benefit_enrollments e
      join hrm_benefit_contribution_rules r on r.org_id=e.org_id and r.id=${ruleId}
      where e.org_id=${orgId} and e.id=${enrollmentId}`)).rows, 'Contribution enrollment and rule');
    await exec.execute(sql`select id from hrm_benefit_plans where org_id=${orgId} and id=${reference.plan_id} for update`);
    await exec.execute(sql`select id from hrm_benefit_enrollments where org_id=${orgId} and id=${enrollmentId} for update`);
    if (reference.status !== 'elected' || reference.submission_snapshot != null) refuse('Submitted contribution elections are immutable — use Change enrollment to submit a successor through its plan approval setting');
    if (reference.plan_id !== reference.rule_plan_id) refuse('Contribution rule belongs to another plan — choose a rule from the enrollment plan');
    const window = dates(body);
    if (window.from < reference.effective_from || reference.effective_to !== null && (window.to === null || window.to > reference.effective_to)) refuse('Contribution dates fall outside enrollment coverage — choose dates inside the coverage window');
    if (body.electionMode !== 'fixed' && body.electionMode !== 'follows_policy') refuse('Declare whether this election fixes its rate or follows plan policy');
    if (body.electionMode === 'fixed') decimal(body, 'electedRate');
    else if (body.electedRate != null && body.electedRate !== '') refuse('A policy-following election cannot also fix a rate — choose one election mode');
    if (body.declaredPeriodsPerYear != null && (!Number.isSafeInteger(body.declaredPeriodsPerYear) || (body.declaredPeriodsPerYear as number) <= 0 || (body.declaredPeriodsPerYear as number) > 366)) refuse('Declared periods per year must be a whole number from 1 through 366');
    return;
  }
  const planId = requireId(body.planId, 'planId');
  const plan = requireOneRow((await exec.execute<{ currency: string }>(sql`select currency from hrm_benefit_plans where org_id=${orgId} and id=${planId} for update`)).rows, 'Contribution plan');
  if (entity === 'benefit-recovery-sources') {
    const rows=(await exec.execute<{id:string;kind:string;basis:string;arrears_plan_id:string|null;unpaid_period_treatment:string}>(sql`select id,kind,basis,arrears_plan_id,unpaid_period_treatment
      from hrm_benefit_contribution_rules where org_id=${orgId} and plan_id=${planId} and id in (${requireId(body.ruleId,'ruleId')},${requireId(body.premiumRuleId,'premiumRuleId')})`)).rows;
    const recovery=rows.find(r=>r.id===body.ruleId),premium=rows.find(r=>r.id===body.premiumRuleId);
    if (!recovery || recovery.kind!=='employee_deduction' || !recovery.arrears_plan_id || recovery.unpaid_period_treatment!=='carry' || !premium || !['employer_contribution','taxable_non_cash'].includes(premium.kind) || !['per_period','per_month','per_year'].includes(premium.basis)) refuse('Link an employee carry deduction with a native recovery bank to flat-period employer premium rules on the same plan');
    const overlap=(await exec.execute(sql`select s.id from hrm_benefit_recovery_sources s
      join hrm_benefit_contribution_rules prior_rule on prior_rule.org_id=s.org_id and prior_rule.id=s.rule_id
      join hrm_benefit_contribution_rules new_rule on new_rule.org_id=s.org_id and new_rule.id=${String(body.ruleId)}::uuid
      where s.org_id=${orgId} and s.premium_rule_id=${String(body.premiumRuleId)}::uuid
        and (${typeof body.id === 'string' ? body.id : null}::uuid is null or s.id<>${typeof body.id === 'string' ? body.id : null}::uuid)
        and daterange(prior_rule.effective_from,prior_rule.effective_to,'[]') && daterange(new_rule.effective_from,new_rule.effective_to,'[]') limit 1`)).rows;
    if (overlap.length) refuse('An insured premium already has a recovery owner during these dates — close the prior recovery rule before linking its successor');
    return;
  }
  if (entity === 'benefit-contribution-classes') {
    if (typeof body.classKey !== 'string' || !body.classKey.trim() || typeof body.name !== 'string' || !body.name.trim()) refuse('A contribution class needs a stable class key and a name');
    return;
  }
  dates(body);
  if (entity === 'benefit-contribution-tiers') {
    if (!Number.isSafeInteger(body.minimumServiceYears) || (body.minimumServiceYears as number) < 0) refuse('Minimum service years must be a non-negative whole number');
    const percent = decimal(body, 'employerMaxPercent')!;
    if (compareDecimal(percent, '100') > 0) refuse('Employer maximum percent cannot exceed 100 — record the percentage of hourly wage');
    decimal(body, 'employeeMatchRatio');
    const classRow = (await exec.execute(sql`select id from hrm_benefit_contribution_classes where org_id=${orgId} and plan_id=${planId} and class_key=${String(body.classKey ?? '')}`)).rows;
    requireOneRow(classRow, 'Contribution class on this plan');
    return;
  }
  const componentId = requireId(body.payComponentId, 'payComponentId');
  const component = requireOneRow((await exec.execute<Record<string, unknown>>(sql`select c.*,a.currency_restriction from pay_components c
    left join accounts a on a.org_id=c.org_id and a.id=c.non_cash_account_id where c.org_id=${orgId} and c.id=${componentId}`)).rows, 'Contribution payroll component');
  const kind = body.kind === 'employee_deduction' ? 'deduction' : body.kind === 'employer_contribution' ? 'employer_contribution' : body.kind === 'taxable_non_cash' ? 'earning' : null;
  if (kind === null || component.kind !== kind || !component.is_active || component.system_key != null) refuse('Link an active user payroll component matching the contribution kind: deduction, employer contribution, or taxable non-cash earning');
  if (body.kind === 'taxable_non_cash' && (component.payment_kind !== 'non_cash' || component.taxable !== true || component.non_cash_account_id == null)) refuse('A taxable non-cash rule requires a taxable non-cash earning with its provider clearing or prepaid account — configure that native payroll component first');
  if (component.currency_restriction != null && component.currency_restriction !== plan.currency) refuse('The non-cash clearing account uses another currency — select an account available to the benefit plan currency');
  const basis = body.basis;
  if (!['per_hour','per_period','per_month','per_year','percent_of_eligible_pay'].includes(String(basis))) refuse('Declare a contribution basis: per hour, per period, per month, per year, or percent of eligible pay');
  decimal(body, 'rate');
  if (basis === 'per_hour' && !['all_paid','regular_paid','scheduled_paid'].includes(String(body.hoursBasis))) refuse('Per-hour contributions need a declared eligible hours basis — choose all paid, regular paid, or scheduled paid hours');
  if (basis === 'percent_of_eligible_pay' && !['all_cash_earnings','regular_cash_earnings'].includes(String(body.payBasis))) refuse('Percent contributions need a declared cash earnings basis — choose all cash earnings or regular cash earnings');
  if (body.kind === 'taxable_non_cash' && component.vacationable === true && basis === 'percent_of_eligible_pay' && body.payBasis === 'all_cash_earnings') refuse('This contribution creates a circular vacation-pay basis — choose regular cash earnings, which excludes derived vacation pay, or use an independent hourly or fixed-period premium');
  if (basis === 'per_month' && (!Number.isSafeInteger(body.monthsPerYear) || (body.monthsPerYear as number) <= 0 || (body.monthsPerYear as number) > 12)) refuse('Monthly annualization requires explicit months per year from 1 through 12');
  if (body.periodsPerYear != null && (!Number.isSafeInteger(body.periodsPerYear) || (body.periodsPerYear as number) <= 0 || (body.periodsPerYear as number) > 366)) refuse('Annualization periods per year must be a whole number from 1 through 366');
  if (!['none','calendar_days'].includes(String(body.proration))) refuse('Declare partial-period proration: none or calendar days');
  if (!['regular_only','all_pay_runs'].includes(String(body.runApplicability))) refuse('Declare run applicability: regular payroll only or all pay runs');
  if (!['charge','carry'].includes(String(body.unpaidPeriodTreatment))) refuse('Declare unpaid-period treatment: charge the current contribution or carry the coverage');
  if (body.arrearsPlanId != null && body.arrearsPlanId !== '') {
    if (body.kind !== 'employee_deduction' || body.unpaidPeriodTreatment !== 'carry') refuse('Benefit recovery banks belong to employee deduction rules that carry unpaid coverage');
    if (!Number.isSafeInteger(body.arrearsRecoveryPeriods) || (body.arrearsRecoveryPeriods as number) <= 0 || (body.arrearsRecoveryPeriods as number) > 52) refuse('Declare the number of prior coverage periods recovered per paid period, from 1 through 52');
    const recovery = requireOneRow((await exec.execute<{ direction: string; unit: string; accrual_method: string; accrual_value: string | null; payout_component_id: string | null }>(sql`select direction,unit,accrual_method,accrual_value::text,payout_component_id from entitlement_plans where org_id=${orgId} and id=${requireId(body.arrearsPlanId,'arrearsPlanId')} and is_active`)).rows, 'Native benefit recovery plan');
    if (recovery.direction !== 'owe' || recovery.unit !== 'money' || recovery.accrual_method !== 'manual' || recovery.accrual_value !== null || recovery.payout_component_id !== componentId) refuse('Select an active money manual owe plan with no independent accrual value, and this deduction component; the Benefits rule owns the contribution amount');
  } else if (body.arrearsRecoveryPeriods != null) refuse('Recovery periods require a native recovery plan — select the plan or clear the recovery periods');
  if (typeof body.id === 'string') {
    const references=(await exec.execute<{rule_id:string;premium_rule_id:string}>(sql`select rule_id,premium_rule_id from hrm_benefit_recovery_sources where org_id=${orgId} and (rule_id=${body.id}::uuid or premium_rule_id=${body.id}::uuid)`)).rows;
    if (references.some(r=>r.rule_id===body.id) && (body.kind!=='employee_deduction' || body.unpaidPeriodTreatment!=='carry' || !body.arrearsPlanId)) refuse('This rule owns insured premium recovery — preserve its native carry deduction or create an effective-dated replacement rule');
    if (references.some(r=>r.premium_rule_id===body.id) && (!['employer_contribution','taxable_non_cash'].includes(String(body.kind)) || !['per_period','per_month','per_year'].includes(String(body.basis)))) refuse('This premium is linked to recovery — preserve its flat employer premium treatment or create an effective-dated replacement rule');
  }
  if (!['elected_rate','hourly_wage_percent','matching_election'].includes(String(body.rateFormula))) refuse('Declare the bounded rate formula: elected rate, hourly wage percent, or matching election');
  if (body.rateFormula !== 'elected_rate' && basis !== 'per_hour') refuse('Wage-percentage and matching rate formulas require a per-hour basis');
  if (body.rateFormula === 'matching_election') {
    if (body.matchRuleId === body.id) refuse('A contribution cannot match itself — select the employee or employer counterpart');
    const counterpart = requireOneRow((await exec.execute<{ kind: string; basis: string; rate_formula: string }>(sql`select kind,basis,rate_formula from hrm_benefit_contribution_rules
      where org_id=${orgId} and plan_id=${planId} and id=${requireId(body.matchRuleId, 'matchRuleId')}`)).rows, 'Matching contribution rule');
    if (counterpart.basis !== 'per_hour' || counterpart.rate_formula !== 'elected_rate' || (counterpart.kind === 'employee_deduction') === (body.kind === 'employee_deduction')) refuse('Match an opposite-side hourly elected-rate contribution — matching cycles and same-side matches are not permitted');
  } else if (body.matchRuleId != null && body.matchRuleId !== '') refuse('Only a matching-election formula can name a matching rule');
}

/** Activation and enrollment share the same effective contribution readiness check. */
export async function validateBenefitPlanActivation(exec: SqlExecutor, orgId: string, planId: string, effectiveFrom: string): Promise<void> {
  const effective = requireCivilDate(effectiveFrom, 'effectiveFrom');
  const rules = (await exec.execute<Record<string, unknown>>(sql`select * from hrm_benefit_contribution_rules
    where org_id=${orgId} and plan_id=${planId} and is_active and effective_from<=${effective}::date
      and (effective_to is null or effective_to>=${effective}::date) order by position,id`)).rows;
  if (!rules.length) refuse('Add effective contribution rules before activating this plan — save the offer inactive and configure its Contributions');
  for (const rule of rules) {
    const values = Object.fromEntries(Object.entries(rule).map(([key,value]) => [key.replace(/_([a-z])/g,(_,letter: string) => letter.toUpperCase()),value]));
    await validateBenefitContributionConfiguration(exec, orgId, 'benefit-contribution-rules', values);
  }
}

export type EnrollmentContributionInput = {
  ruleId: string; electionMode: 'fixed' | 'follows_policy'; electedRate?: string | null;
  declaredPeriodsPerYear?: number | null; sourceDecimal?: string | null; provenance?: Readonly<Record<string, unknown>>;
};
/** Election terms share enrollment admission and approval; payroll consumes only active enrollments. */
export async function recordEnrollmentContributionTerms(exec: SqlExecutor, orgId: string, actorId: string, enrollmentId: string, effectiveFrom: string, effectiveTo: string | null, inputs?: readonly EnrollmentContributionInput[]): Promise<void> {
  const enrollment = requireOneRow((await exec.execute<{ plan_id: string }>(sql`select plan_id from hrm_benefit_enrollments where org_id=${orgId} and id=${enrollmentId}`)).rows, 'Recording enrollment contribution terms');
  const rules = (await exec.execute<{ id: string }>(sql`select id from hrm_benefit_contribution_rules where org_id=${orgId} and plan_id=${enrollment.plan_id}
    and is_active and effective_from<=${effectiveFrom}::date and (effective_to is null or effective_to>=${effectiveFrom}::date) order by position,id`)).rows;
  if (rules.length === 0) refuse('This plan has no effective recurring contribution rules — configure its Contributions before enrolling an employee');
  if (inputs === undefined && rules.length > 0) refuse('Record the contribution elections as fixed rates or policy-following terms before activating this enrollment');
  const terms: readonly EnrollmentContributionInput[] = inputs ?? [];
  const seen = new Set<string>();
  for (const term of terms) {
    if (seen.has(term.ruleId)) refuse('The election repeats a contribution rule — record one term for each elected contribution');
    seen.add(term.ruleId);
    if (!rules.some(r => r.id === term.ruleId)) refuse('Election contribution rule is inactive, outside its dates, or belongs to another plan — choose an effective rule on this plan');
    await validateBenefitContributionConfiguration(exec, orgId, 'benefit-enrollment-terms', { ...term, enrollmentId, effectiveFrom, effectiveTo });
    const inserted = (await exec.execute(sql`insert into hrm_benefit_enrollment_terms
      (org_id,enrollment_id,rule_id,election_mode,elected_rate,declared_periods_per_year,effective_from,effective_to,source_decimal,provenance,created_by,updated_by)
      values (${orgId},${enrollmentId},${term.ruleId},${term.electionMode},${term.electedRate ?? null},${term.declaredPeriodsPerYear ?? null},
      ${effectiveFrom}::date,${effectiveTo}::date,${term.sourceDecimal ?? null},${JSON.stringify(term.provenance ?? {})}::jsonb,${actorId},${actorId}) returning id`)).rows;
    requireOneRow(inserted, 'Recording enrollment contribution election');
  }
  if (rules.length > 0 && terms.length === 0) refuse('This plan has recurring contributions — record the employee election terms or waive the enrollment');
}

export async function listEnrollmentContributionTerms(query: { orgId: string; actorId: string; enrollmentId: string }): Promise<Record<string, unknown>[]> {
  const orgId = requireOrgId(query.orgId), actorId = requireActorId(query.actorId), enrollmentId = requireId(query.enrollmentId, 'enrollmentId');
  return withOrgTransaction(orgId, async () => {
    await assertHrmEnabled(db, orgId);
    const notFound = (): never => { throw new BenefitsError('NOT_FOUND', 'Contribution enrollment is not visible in this organization and legal-entity scope — reload and retry'); };
    const employment = (await db.execute<{ employment_id: string }>(sql`select employment_id from hrm_benefit_enrollments where org_id=${orgId} and id=${enrollmentId}`)).rows[0];
    if (!employment) return notFound();
    try { await requireHrmBenefitsManageOnEmployment(db, orgId, actorId, employment.employment_id); }
    catch (error) { if (error instanceof HrmAuthorizationError) return notFound(); throw error; }
    return (await db.execute<Record<string, unknown>>(sql`select t.id,t.rule_id as "ruleId",r.rule_key as "ruleKey",r.name,r.kind,r.basis,
      t.election_mode as "electionMode",t.elected_rate::text as "electedRate",t.declared_periods_per_year as "declaredPeriodsPerYear",
      t.effective_from::text as "effectiveFrom",t.effective_to::text as "effectiveTo",t.source_decimal as "sourceDecimal",t.provenance
      from hrm_benefit_enrollment_terms t join hrm_benefit_contribution_rules r on r.org_id=t.org_id and r.id=t.rule_id
      where t.org_id=${orgId} and t.enrollment_id=${enrollmentId} order by r.position,t.effective_from,t.id`)).rows;
  });
}

import { parseMoney, parseRate, type Money } from '../money/brands.ts';
import { add, cmp, neg, sum, mulDecimalFactors, mulPercent, mulRatio, roundMoney } from '../money/money.ts';
import { compareDecimal, divideDecimal, multiplyDecimal } from '../money/exact-decimal.ts';
import { PayrollError } from './error.ts';

export type BenefitContributionKind = 'employee_deduction' | 'employer_contribution' | 'taxable_non_cash';
export type BenefitContributionBasis = 'per_hour' | 'per_period' | 'per_month' | 'per_year' | 'percent_of_eligible_pay';
export interface RecurringBenefitRule {
  id: string; planId: string; ruleKey: string; name: string; kind: BenefitContributionKind;
  payComponentId: string; basis: BenefitContributionBasis; rate: string;
  rateFormula: 'elected_rate' | 'hourly_wage_percent' | 'matching_election';
  hoursBasis: 'all_paid' | 'regular_paid' | 'scheduled_paid' | null;
  payBasis: 'all_cash_earnings' | 'regular_cash_earnings' | null;
  monthsPerYear: number | null; periodsPerYear: number | null;
  proration: 'none' | 'calendar_days'; matchRuleId: string | null;
  requiresMatchEligibility: boolean; enforcePolicyCap: boolean;
  position: number; effectiveFrom: string; effectiveTo: string | null;
  runApplicability: 'regular_only' | 'all_pay_runs'; unpaidPeriodTreatment: 'charge' | 'carry';
  arrearsPlanId: string | null; arrearsRecoveryPeriods: number | null;
}
export interface RecurringBenefitTerm {
  id: string; enrollmentId: string; ruleId: string; electionMode: 'fixed' | 'follows_policy';
  electedRate: string | null; declaredPeriodsPerYear: number | null;
  effectiveFrom: string; effectiveTo: string | null;
  overrideReason: string | null; overrideApprovedBy: string | null; overrideApprovedAt: string | null;
}
export interface BenefitContributionTier {
  id: string; minimumServiceYears: number; employerMaxPercent: string; employeeMatchRatio: string;
}
export interface RecurringBenefitBasis {
  hours: string; eligiblePay: string; hourlyWage: string | null; periodsPerYear: number;
  coveredDays: number; periodDays: number; matchEligible: boolean | null;
  tier: BenefitContributionTier | null; matchingElectedRate: string | null;
}

/** Fixed elections never progress when a ceiling changes. A ceiling binds only when policy declares it. */
export function recurringBenefitAmount(rule: RecurringBenefitRule, term: RecurringBenefitTerm, basis: RecurringBenefitBasis): { amount: Money; rate: string; maximumRate: string | null } {
  const refuse = (message: string): never => { throw new PayrollError(`Benefit rule ${rule.ruleKey}: ${message}`); };
  if (rule.requiresMatchEligibility && basis.matchEligible === null) refuse('matching eligibility is unknown — record the employee election eligibility before calculating payroll');
  if (rule.requiresMatchEligibility && !basis.matchEligible) return { amount: parseMoney('0'), rate: '0', maximumRate: null };
  const tierRequired = rule.rateFormula !== 'elected_rate' && term.electionMode === 'follows_policy' || rule.enforcePolicyCap;
  let maximumRate: string | null = null;
  if (tierRequired) {
    if (!basis.tier || !basis.hourlyWage) refuse('no class/service tier and hourly wage resolve — configure the employee contribution class, credited service and applicable policy tier');
    maximumRate = divideDecimal(multiplyDecimal(basis.hourlyWage!,basis.tier!.employerMaxPercent,12),'100',10);
    if (rule.kind === 'employee_deduction') maximumRate = multiplyDecimal(maximumRate,basis.tier!.employeeMatchRatio,10);
  }
  let rate: string;
  if (term.electionMode === 'fixed') {
    if (term.electedRate === null) refuse('the fixed election has no rate — record its elected rate');
    rate = parseRate(term.electedRate);
  } else if (rule.rateFormula === 'elected_rate') {
    rate = parseRate(rule.rate);
  } else if (rule.rateFormula === 'hourly_wage_percent') {
    rate = maximumRate!;
  } else {
    if (basis.matchingElectedRate === null) refuse('the matching election is missing — record a fixed election on the linked contribution rule');
    const ratio = basis.tier!.employeeMatchRatio;
    if (rule.kind === 'employee_deduction') rate = multiplyDecimal(basis.matchingElectedRate!,ratio,10);
    else {
      if (compareDecimal(ratio, '0') <= 0) refuse('the employee match ratio is zero — configure a positive ratio before matching');
      rate = divideDecimal(basis.matchingElectedRate!, ratio, 10);
    }
    if (maximumRate !== null && compareDecimal(rate, maximumRate) > 0) rate = maximumRate;
  }
  const canonicalRate = parseRate(rate);
  if (canonicalRate.startsWith('-')) refuse('the contribution rate is negative — record a non-negative rate');
  if (rule.enforcePolicyCap && maximumRate !== null && compareDecimal(rate, maximumRate) > 0 && !(term.overrideReason && term.overrideApprovedBy && term.overrideApprovedAt)) {
    refuse(`elected hourly rate ${rate} exceeds the declared maximum ${maximumRate} — record an independently approved override or amend the election`);
  }
  let amount: string;
  switch (rule.basis) {
    case 'per_hour':
      if (!rule.hoursBasis) refuse('eligible hours are undeclared — choose all paid or regular paid hours');
      amount = mulDecimalFactors('1', [canonicalRate, basis.hours]);
      break;
    case 'percent_of_eligible_pay':
      if (!rule.payBasis) refuse('eligible earnings are undeclared — choose the cash earnings basis');
      amount = mulPercent(basis.eligiblePay, canonicalRate);
      break;
    case 'per_period': amount = mulDecimalFactors('1', [canonicalRate]); break;
    case 'per_month':
    case 'per_year': {
      const periods = term.declaredPeriodsPerYear ?? rule.periodsPerYear;
      if (!periods || periods !== basis.periodsPerYear) refuse(`annualization is not declared for this ${basis.periodsPerYear}-period schedule — record the exact periods per year on the rule or election`);
      const months = rule.basis === 'per_month' ? rule.monthsPerYear : 1;
      if (!months) refuse('monthly annualization is undeclared — record months per year');
      amount = mulRatio(mulDecimalFactors('1', [canonicalRate]), BigInt(months!), BigInt(periods!));
      break;
    }
    default: return refuse('the contribution basis is unsupported — configure one of the native recurring contribution bases');
  }
  // Hours and eligible pay already represent the covered slice. Flat-period
  // rates alone require calendar-day proration; applying it to hours doubles it.
  if (rule.proration === 'calendar_days' && !['per_hour', 'percent_of_eligible_pay'].includes(rule.basis)) {
    if (basis.periodDays <= 0) refuse('the pay period is empty — choose a valid inclusive pay period');
    amount = mulRatio(amount, BigInt(basis.coveredDays), BigInt(basis.periodDays));
  }
  return { amount: parseMoney(roundMoney(amount, 2)), rate: canonicalRate, maximumRate };
}

export interface BenefitRecoveryLedgerEntry { id: string; planId: string; documentId: string | null; movementDate: string; kind: string; amount: string }
/** Recover actual prior coverage periods from the native bank, with void reversals netted by run. */
export function benefitCoverageRecoveryAmount(entries: readonly BenefitRecoveryLedgerEntry[], periods: number): string {
  if (!Number.isSafeInteger(periods) || periods < 1 || periods > 52) throw new PayrollError('Benefit recovery requires one through fifty-two prior coverage periods — configure its declared recovery policy');
  const runs = new Map<string, BenefitRecoveryLedgerEntry[]>();
  for (const entry of entries) {
    if (cmp(entry.amount,'0') === 0) continue;
    if (entry.documentId === null) throw new PayrollError('Benefit recovery requires period-attributed coverage debt — select a dedicated native owe bank without unrelated opening balances');
    const group=runs.get(entry.documentId) ?? []; group.push(entry); runs.set(entry.documentId,group);
  }
  const debts: {date:string;id:string;amount:string}[]=[];
  let repayments='0';
  for (const [id,group] of runs) {
    const amount=sum(group.map(e=>e.amount));
    if (cmp(amount,'0') === 0) continue;
    if (cmp(amount,'0') < 0) {
      if (!group.some(e=>e.kind==='bank_in' && cmp(e.amount,'0') < 0)) throw new PayrollError('Benefit recovery bank contains unrelated debt — select its dedicated native coverage bank');
      debts.push({date:group.map(e=>e.movementDate).sort()[0]!,id,amount:neg(amount)});
    } else {
      if (!group.some(e=>e.kind==='repayment')) throw new PayrollError('Benefit recovery bank contains unrelated credits — select its dedicated native coverage bank');
      repayments=add(repayments,amount);
    }
  }
  const remaining:string[]=[];
  for (const debt of debts.sort((a,b)=>a.date.localeCompare(b.date)||a.id.localeCompare(b.id))) {
    const consumed=cmp(repayments,debt.amount) < 0 ? repayments : debt.amount;
    repayments=add(repayments,neg(consumed));
    const outstanding=add(debt.amount,neg(consumed));
    if (cmp(outstanding,'0') > 0) remaining.push(outstanding);
  }
  return sum(remaining.slice(0,periods));
}

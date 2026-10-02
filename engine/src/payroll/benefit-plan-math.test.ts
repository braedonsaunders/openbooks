import test from 'node:test';
import assert from 'node:assert/strict';
import { benefitCoverageRecoveryAmount, recurringBenefitAmount, type RecurringBenefitRule, type RecurringBenefitTerm, type RecurringBenefitBasis } from './benefit-plan-math.ts';
import { computePlanMovement } from './entitlements-movement-kernel.ts';
import type { EntitlementPlan } from './entitlements-types.ts';
const rule: RecurringBenefitRule = { id:'rule',planId:'plan',ruleKey:'savings',name:'Savings',kind:'employer_contribution',payComponentId:'component',basis:'per_hour',rate:'1',rateFormula:'elected_rate',hoursBasis:'all_paid',payBasis:null,monthsPerYear:null,periodsPerYear:null,proration:'none',matchRuleId:null,requiresMatchEligibility:false,enforcePolicyCap:false,position:0,effectiveFrom:'2026-01-01',effectiveTo:null,runApplicability:'all_pay_runs',unpaidPeriodTreatment:'charge',arrearsPlanId:null,arrearsRecoveryPeriods:null };
const term: RecurringBenefitTerm = { id:'term',enrollmentId:'enrollment',ruleId:'rule',electionMode:'fixed',electedRate:'1.2345678912',declaredPeriodsPerYear:null,effectiveFrom:'2026-01-01',effectiveTo:null,overrideReason:null,overrideApprovedBy:null,overrideApprovedAt:null };
const basis: RecurringBenefitBasis = { hours:'40',eligiblePay:'1200',hourlyWage:'30',periodsPerYear:52,coveredDays:7,periodDays:7,matchEligible:true,tier:{id:'tier',minimumServiceYears:1,employerMaxPercent:'3.5',employeeMatchRatio:'2'},matchingElectedRate:null };
test('fixed contributions preserve the elected precision and do not follow increasing ceilings', () => {
  for (const wage of ['30','50','100']) assert.equal(recurringBenefitAmount(rule,term,{...basis,hourlyWage:wage}).amount,'49.3800');
  assert.equal(recurringBenefitAmount(rule,term,basis).rate,'1.2345678912');
});
test('declared employee and employer ceilings remain distinct from fixed elections', () => {
  const policy = { ...term,electionMode:'follows_policy' as const,electedRate:null };
  assert.equal(recurringBenefitAmount({...rule,rateFormula:'hourly_wage_percent'},policy,basis).amount,'42.0000');
  assert.equal(recurringBenefitAmount({...rule,kind:'employee_deduction',rateFormula:'hourly_wage_percent'},policy,basis).amount,'84.0000');
  assert.throws(()=>recurringBenefitAmount({...rule,enforcePolicyCap:true},term,basis),/exceeds the declared maximum 1\.0500000000.*approved override or amend the election/);
  assert.equal(recurringBenefitAmount({...rule,enforcePolicyCap:false},term,basis).amount,'49.3800');
  assert.equal(recurringBenefitAmount({...rule,rateFormula:'hourly_wage_percent'},policy,{...basis,hourlyWage:'30.1234'}).rate,'1.054319');
});
test('matching requires explicit eligibility and a fixed counterpart without increasing either election', () => {
  const policy = {...term,electionMode:'follows_policy' as const,electedRate:null};
  const matching = {...rule,rateFormula:'matching_election' as const,matchRuleId:'employee',requiresMatchEligibility:true};
  assert.equal(recurringBenefitAmount(matching,policy,{...basis,matchingElectedRate:'1.5'}).amount,'30.0000');
  assert.equal(recurringBenefitAmount(matching,policy,{...basis,matchEligible:false}).amount,'0.0000');
  assert.throws(()=>recurringBenefitAmount(matching,policy,{...basis,matchEligible:null}),/eligibility is unknown.*record the employee election eligibility/);
});
test('monthly premiums explicitly annualize twelve months over fifty-two weekly periods', () => {
  const monthly = {...rule,basis:'per_month' as const,monthsPerYear:12,periodsPerYear:52};
  const election = {...term,electedRate:'43.3333333333'};
  assert.equal(recurringBenefitAmount(monthly,election,basis).amount,'10.0000');
  assert.equal(recurringBenefitAmount({...monthly,proration:'calendar_days'},election,{...basis,coveredDays:3,periodDays:7}).amount,'4.2900');
  assert.throws(()=>recurringBenefitAmount({...monthly,periodsPerYear:26},election,basis),/annualization is not declared.*record the exact periods per year/);
});
test('hour and earnings bases scale only once over partial periods', () => {
  assert.equal(recurringBenefitAmount({...rule,proration:'calendar_days'},{...term,electedRate:'2'},{...basis,hours:'16',coveredDays:3}).amount,'32.0000');
  assert.equal(recurringBenefitAmount({...rule,basis:'percent_of_eligible_pay',payBasis:'all_cash_earnings',proration:'calendar_days'},{...term,electedRate:'5'},{...basis,eligiblePay:'600',coveredDays:3}).amount,'30.0000');
});
test('unpaid coverage uses the native owe bank and recovers the declared prior periods plus current coverage', () => {
  const plan: EntitlementPlan = {id:'recovery',code:'RECOVERY',systemKey:null,name:'Benefit recovery',unit:'money',direction:'owe',accrualMethod:'manual',accrualValue:null,accrualComponentId:null,payoutComponentId:'deduction',liabilityAccountId:null,capBehavior:'warn'};
  const input={plan,employeePartyId:'employee',movementDate:'2026-07-01',openingBalance:'0',earnings:'0',hours:'0',limit:null};
  const carried=computePlanMovement({...input,unpaidCoverageValue:'10'});
  assert.equal(carried.closingBalance,'-10.0000');
  assert.deepEqual(carried.movements.map(m=>[m.kind,m.amount,m.componentId]),[['bank_in','-10.0000',null]]);
  const recovered=computePlanMovement({...input,openingBalance:'-30',scheduledRepaymentValue:'20'});
  assert.equal(recovered.closingBalance,'-10.0000');
  assert.equal(recovered.movements[0]!.amount,'20.0000');
  assert.equal(computePlanMovement({...input,openingBalance:'-5',scheduledRepaymentValue:'20'}).closingBalance,'0.0000');
});

test('prior coverage recovery preserves actual premiums, partial repayment and native void reversals', () => {
  const entry=(id:string,date:string,kind:string,amount:string)=>({id,planId:'bank',documentId:id,movementDate:date,kind,amount});
  const rows=[entry('one','2026-07-01','bank_in','-38'),entry('two','2026-07-08','bank_in','-42'),entry('three','2026-07-15','bank_in','-50'),entry('paid','2026-07-20','repayment','10')];
  assert.equal(benefitCoverageRecoveryAmount(rows,2),'70.0000');
  assert.equal(benefitCoverageRecoveryAmount([...rows,{...rows[1]!,id:'reversal',kind:'adjustment',amount:'42'}],2),'78.0000');
  assert.throws(()=>benefitCoverageRecoveryAmount([{...rows[0]!,documentId:null}],2),/period-attributed coverage debt.*dedicated native owe bank/);
});

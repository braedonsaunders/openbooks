import {sql} from 'drizzle-orm'
import {isIsoCalendarDate} from '../../platform/business-date.ts'
import {add,cmp,sum} from '../../money/money.ts'
import {certificateAnswersProblem} from '../certificates.ts'
import {PayrollError} from '../error.ts'
import {at,DAY,iso,nextPeriodAfter,type ScheduleRow} from '../run-calendar.ts'
import type {PayrollStatutoryComputeContext} from '../statutory-context.ts'
import type {T4127Averaging,T4127Ytd} from './t4127.ts'
import {CA_OPENING_YTD_FIELDS} from './opening-ytd.ts'

const HISTORY_FIELDS=[
  {key:"income",openingKey:"caAvgIncome",factor:"I"},
  {key:"pensionDeductions",openingKey:"caAvgPensionF",factor:"F"},
  {key:"alimonyDeductions",openingKey:"caAvgAlimony",factor:"F2"},
  {key:"unionDues",openingKey:"caAvgUnionDues",factor:"U1"},
  {key:"f5A",openingKey:"caAvgF5A",factor:"F5A"},
  {key:"pensionablePeriodic",openingKey:"caAvgPe",factor:"CA_PE"},
  {key:"insurablePeriodic",openingKey:"caAvgIe",factor:"CA_IE"},
  {key:"qpipPeriodic",openingKey:"caAvgQpip",factor:"CA_QPIP_PE"},
  {key:"pensionableNonPeriodic",openingKey:"caAvgBonusPe",factor:"CA_BPE"},
  {key:"insurableNonPeriodic",openingKey:"caAvgBonusIe",factor:"CA_BIE"},
  {key:"qpipNonPeriodic",openingKey:"caAvgBonusQpip",factor:"CA_BQPIP"},
  {key:"periodicTax",openingKey:"caAvgTaxM",factor:"CA_T_BASE"},
  {key:"bonusTax",openingKey:"caAvgTaxM1",factor:"TB"},
  {key:"nonPeriodic",openingKey:"caAvgBonus",factor:"B"},
  {key:"nonPeriodicPensionDeductions",openingKey:"caAvgF4",factor:"F3"},
  {key:"nonPeriodicCppEnhancedDeductions",openingKey:"caAvgF5B",factor:"F5B"},
] as const

/** Option 2's income-tax window is distinct from the full year's CPP/EI
 * ceilings. Off-cycle cheques never become additional scheduled periods. */
export async function cumulativeHistory(ctx:PayrollStatutoryComputeContext):Promise<{averaging:T4127Averaging;bonusYtd:Pick<T4127Ytd,'nonPeriodic'|'nonPeriodicPensionDeductions'|'nonPeriodicCppEnhancedDeductions'>}|null> {
  const record=ctx.certificateFor('ca_t4127_method')
  if(!record?.onFile)return null
  const problem=certificateAnswersProblem(record.certificate,record.answers)
  if(problem)throw new PayrollError(`${problem} — correct the employer withholding method record in the employee’s Payroll profile`)
  if(record.answers.method==='option1')return null
  if(record.missing.length||record.answers.method!=='option2'||!record.effectiveFrom)throw new PayrollError('Complete and date the employer withholding method election in the employee’s Payroll profile before calculating cumulative averaging')
  const yearStart=`${ctx.taxYear}-01-01`
  const declaredStart=record.answers.window_start||record.effectiveFrom
  if(!isIsoCalendarDate(declaredStart)||declaredStart>ctx.run.pay_date!)throw new PayrollError('Set an averaging window start in YYYY-MM-DD on or before this pay date in the employee’s Payroll withholding method record')
  const start=declaredStart<yearStart?yearStart:declaredStart
  const recordedThrough=record.answers.opening_history_through
  if(recordedThrough&&!isIsoCalendarDate(recordedThrough))throw new PayrollError("Set the imported averaging history-through date in YYYY-MM-DD in the employee’s withholding method record")
  const through=recordedThrough&&recordedThrough>=yearStart?recordedThrough:null
  if(through&&(!isIsoCalendarDate(through)||through<start||through>=ctx.run.pay_date!))throw new PayrollError('Imported averaging history must end within this averaging window and before the current pay date — correct its history-through date in the Payroll profile')
  if(through&&record.answers.opening_history_complete!=='true')throw new PayrollError('Verify every averaging opening field against the prior provider’s report in Payroll → Opening Balances, then confirm complete imported history in the employee’s withholding method record')
  if(start<record.effectiveFrom&&!through)throw new PayrollError('An averaging window before this method election requires complete imported history — supply its history-through date and opening balances, or reset the window to the election date')
  const schedule=(await ctx.tx.execute<ScheduleRow>(sql`select id,frequency,periods_per_year,anchor_period_end::text,pay_date_offset_days from pay_schedules where org_id=${ctx.orgId} and id=${ctx.run.pay_schedule_id}`)).rows[0]
  if(!schedule)throw new PayrollError('Restore this run’s pay schedule before calculating cumulative averaging')
  let cursor=iso(new Date(at(start).getTime()-DAY*(schedule.pay_date_offset_days+1)))
  let elapsed=0
  for(let n=0;n<370;n++){
    const period=nextPeriodAfter(schedule,cursor)
    const payday=iso(new Date(at(period.periodEnd).getTime()+DAY*schedule.pay_date_offset_days))
    if(payday>ctx.run.pay_date!)break
    if(payday>=start)elapsed++
    cursor=period.periodEnd
  }
  // Before the first scheduled payday, an off-cycle cheque uses the first
  // projection period; it creates no extra calendar boundary for later runs.
  elapsed=Math.max(1,elapsed)
  if(elapsed>ctx.periodsPerYear)throw new PayrollError('The averaging calendar exceeds the schedule’s periods per year — correct its calendar or reset the elected window')
  const history=(await ctx.tx.execute<{pay_date:string;schedule_id:string;factors:Record<string,string>}>(sql`
    select r.pay_date::text,r.pay_schedule_id as schedule_id,s.factors from pay_stubs s
      join pay_runs r on r.org_id=s.org_id and r.document_id=s.pay_run_document_id
      join documents d on d.org_id=r.org_id and d.id=r.document_id
    where s.org_id=${ctx.orgId} and s.employee_party_id=${ctx.employeePartyId} and s.tax_year=${ctx.taxYear}
      and s.pay_run_document_id<>${ctx.documentId} and r.run_status='committed' and d.status<>'voided'
      and r.pay_date>=${start}::date
      ${ctx.subsidiaryId?sql`and d.subsidiary_id=${ctx.subsidiaryId}`:sql``}
    order by r.pay_date,s.id`)).rows
  if(history.some(row=>row.pay_date>ctx.run.pay_date!))throw new PayrollError('A later pay run is already committed in this averaging window — correct payroll through the controlled void and replacement workflow before recalculating an earlier pay date')
  if(history.some(row=>row.schedule_id!==schedule.id))throw new PayrollError('The averaging window spans different pay schedules — reset the employer withholding method window on the new schedule’s effective date')
  if(through&&history.some(row=>row.pay_date<=through))throw new PayrollError('Imported averaging history overlaps committed payroll — correct its history-through date and opening balances before calculating')
  const opening=through?(await ctx.tx.execute<Record<string,string>>(sql`select * from payroll_opening_balances where org_id=${ctx.orgId} and employee_party_id=${ctx.employeePartyId} and tax_year=${ctx.taxYear}`)).rows[0]:undefined
  if(through&&!opening)throw new PayrollError('Imported averaging history has no opening balance row — enter the verified Canada averaging fields in Payroll → Opening Balances before calculating')
  if(opening){
    const excess=(parts:string[],whole:string)=>cmp(sum(parts.map(key=>opening[key]!)),opening[whole]!)>0
    if(excess(['ca_avg_income','ca_avg_bonus'],'taxable_ytd')||excess(['ca_avg_pe','ca_avg_bonus_pe'],'pensionable_ytd')||excess(['ca_avg_ie','ca_avg_bonus_ie'],'insurable_ytd')||excess(['ca_avg_tax_m','ca_avg_tax_m1'],'tax_ytd'))
      throw new PayrollError('Imported averaging-window earnings or withholding exceed calendar-year opening balances — reconcile both sets to the prior provider’s report in Payroll → Opening Balances')
  }
  const amounts:Record<string,string>={}
  for(const field of HISTORY_FIELDS){
    if(history.some(row=>row.factors[field.factor]==null))throw new PayrollError(`Committed payroll lacks ${field.factor} history required for cumulative averaging — reset the employer withholding method window after that payroll or replace it through the controlled payroll correction workflow`)
    const column=CA_OPENING_YTD_FIELDS.find(row=>row.key===field.openingKey)!.column
    amounts[field.key]=sum([opening?.[column]??'0',...history.map(row=>row.factors[field.factor]!)])
  }
  // M excludes L at the producer, so additional voluntary withholding never
  // reduces a later statutory deduction; TB stays in M1 rather than M.
  for(const key of ['periodicTax','bonusTax'])if(add(amounts[key]!,'0').startsWith('-'))throw new PayrollError('Averaging withholding history cannot be negative — review its committed correction history')
  return {averaging:{...amounts,elapsedPeriods:elapsed} as unknown as T4127Averaging,bonusYtd:{nonPeriodic:amounts.nonPeriodic,nonPeriodicPensionDeductions:amounts.nonPeriodicPensionDeductions,nonPeriodicCppEnhancedDeductions:amounts.nonPeriodicCppEnhancedDeductions}}
}

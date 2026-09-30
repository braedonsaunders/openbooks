import {sql} from 'drizzle-orm'
import {db} from '../platform/db.ts'
import {isIsoCalendarDate} from '../platform/business-date.ts'
import {lockActorCommandAuthority} from '../organization/actor-command-authority.ts'
import {lockScopeRows} from '../organization/subsidiary-scope.ts'
import {requirePayrollFeature} from './feature-gate.ts'
import {PayrollError} from './error.ts'
import {employeeTaxYearFenceKey,takeEmployeeTaxYearFences} from './fences.ts'

/** Called inside the certificate write transaction, before its profile lock.
 * The employee configuration fence also belongs to calculation and commit. */
export async function prepareWithholdingRecordWrite(input:{orgId:string;actorId:string;employeePartyId:string;effectiveFrom:string;protectCommittedHistory:boolean}) {
  if(!isIsoCalendarDate(input.effectiveFrom))throw new PayrollError('Set a real withholding record effective date in YYYY-MM-DD before saving')
  const allowed=await lockActorCommandAuthority(db,input.orgId,input.actorId,null,'payroll.manage')
  await requirePayrollFeature(db,input.orgId)
  await takeEmployeeTaxYearFences(db,[employeeTaxYearFenceKey(input.orgId,input.employeePartyId,Number(input.effectiveFrom.slice(0,4)))])
  await lockScopeRows(db,input.orgId,[{kind:'party',id:input.employeePartyId}],allowed,'share')
  if(!input.protectCommittedHistory)return
  const posted=(await db.execute<{pay_date:string}>(sql`select r.pay_date::text from pay_runs r
    join pay_stubs s on s.org_id=r.org_id and s.pay_run_document_id=r.document_id
    join documents d on d.org_id=r.org_id and d.id=r.document_id
    where r.org_id=${input.orgId} and s.employee_party_id=${input.employeePartyId} and r.run_status='committed' and d.status<>'voided'
      and r.pay_date>=${input.effectiveFrom}::date order by r.pay_date desc limit 1`)).rows[0]
  if(posted)throw new PayrollError(`Payroll dated ${posted.pay_date} is already committed — make the withholding method election effective after that pay date, or use payroll’s controlled void and replacement workflow before changing that history`)
}

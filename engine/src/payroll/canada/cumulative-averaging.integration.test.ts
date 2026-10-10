import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import test from 'node:test'
import {sql} from 'drizzle-orm'
import {db,withBypassContext,withOrgContext,withOrgTransaction} from '../../platform/db.ts'
import {dropScratchOrgReporting} from '../../testing/fixtures.ts'
import {seedAdoption} from '../filing-test-fixtures.ts'
import {createPayRun} from '../run-lifecycle.ts'
import {calculatePayRun} from '../run-calculation.ts'
import {commitPayRun} from '../run-commit.ts'
import {prepareWithholdingRecordWrite} from '../withholding-record-write.ts'
import {saveOpeningBalances} from '../opening-balances.ts'
import {mutatePayRunAdjustment} from '../run-adjustments.ts'

test('elected cumulative withholding consumes committed history and scheduled periods while resets preserve annual contribution ceilings',{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
  const fixture=await withBypassContext(()=>seedAdoption())
  const {orgId,actorId,employeeId,scheduleId}=fixture
  try{
    await withBypassContext(async()=>{
      await db.execute(sql`update pay_schedules set frequency='monthly',periods_per_year=12,anchor_period_end='2026-01-31',pay_date_offset_days=0 where org_id=${orgId} and id=${scheduleId}`)
      await db.execute(sql`update employee_payroll_profiles set additional_tax_per_period=10 where org_id=${orgId} and employee_party_id=${employeeId}`)
      await db.execute(sql`insert into employee_tax_certificates(org_id,employee_party_id,country,certificate_key,answers,effective_from,created_by,updated_by)
        values(${orgId},${employeeId},'CA','ca_t4127_method','{"method":"option2","reason":"Employer elected cumulative withholding for uneven pay"}'::jsonb,'2026-01-01',${actorId},${actorId})`)
    })
    await withOrgContext(orgId,async()=>{
      const components=(await db.execute<{id:string;system_key:string}>(sql`select id,system_key from pay_components where org_id=${orgId} and system_key in ('base_pay','bonus')`)).rows
      const run=async(start:string,end:string,amount:string,type:'regular'|'bonus'='regular')=>{
        const created=await createPayRun({orgId,actorId,payScheduleId:scheduleId,periodStart:start,periodEnd:end,payDate:end,runType:type})
        const input={orgId,actorId,documentId:created.documentId}
        await mutatePayRunAdjustment({...input,mutation:{action:'add',employeePartyId:employeeId,componentId:components.find(row=>row.system_key===(type==='bonus'?'bonus':'base_pay'))!.id,amount,idempotencyKey:randomUUID()}})
        const result=await calculatePayRun(input);assert.deepEqual(result.errors,[])
        const factors=(await db.execute<{factors:Record<string,string>}>(sql`select factors from pay_stubs where org_id=${orgId} and pay_run_document_id=${created.documentId}`)).rows[0]!.factors
        await commitPayRun(input)
        return factors
      }
      const first=await run('2026-01-01','2026-01-31','100000')
      assert.equal(first.S1_DEN,'1.0000');assert.equal(first.C,'4230.4500');assert.equal(first.EI,'1123.0700')
      const second=await run('2026-02-01','2026-02-28','1000')
      assert.equal(second.S1_DEN,'2.0000');assert.equal(second.T,'10.0000');assert.equal(second.M,first.CA_T_BASE)
      assert.equal(second.C,'0.0000');assert.equal(second.C2,'0.0000');assert.equal(second.EI,'0.0000')
      const bonus=await run('2026-03-01','2026-03-15','1000','bonus')
      assert.equal(bonus.S1_DEN,'2.0000');assert.equal(bonus.M,first.CA_T_BASE)
      assert.equal(bonus.C,'0.0000');assert.equal(bonus.EI,'0.0000')
      const third=await run('2026-03-16','2026-03-31','1000')
      assert.equal(third.S1_DEN,'3.0000');assert.equal(third.M1,bonus.TB);assert.equal(third.M,first.CA_T_BASE)
      // The effective election resets income tax only. It cannot reopen CPP/EI
      // room already consumed and actually committed earlier in this year.
      await assert.rejects(withOrgTransaction(orgId,()=>prepareWithholdingRecordWrite({orgId,actorId,employeePartyId:employeeId,effectiveFrom:'2026-01-01',protectCommittedHistory:true})),/already committed.*effective after/)
      const retired=await db.execute(sql`update employee_tax_certificates set superseded_on='2026-04-01',updated_by=${actorId},updated_at=now() where org_id=${orgId} and employee_party_id=${employeeId} and certificate_key='ca_t4127_method' and superseded_on is null returning id`)
      assert.equal(retired.rows.length,1)
      await db.execute(sql`insert into employee_tax_certificates(org_id,employee_party_id,country,certificate_key,answers,effective_from,created_by,updated_by)
        values(${orgId},${employeeId},'CA','ca_t4127_method','{"method":"option2","reason":"Employer elected cumulative withholding for uneven pay"}'::jsonb,'2026-04-01' ,${actorId},${actorId})`)
      const reset=await run('2026-04-01','2026-04-30','1000')
      assert.equal(reset.S1_DEN,'1.0000');assert.equal(reset.M,'0.0000');assert.equal(reset.M1,'0.0000')
      assert.equal(reset.C,'0.0000');assert.equal(reset.EI,'0.0000')
      const draft=await createPayRun({orgId,actorId,payScheduleId:scheduleId,periodStart:'2026-05-01',periodEnd:'2026-05-31',payDate:'2026-05-31'})
      const command={orgId,actorId,documentId:draft.documentId}
      await mutatePayRunAdjustment({...command,mutation:{action:'add',employeePartyId:employeeId,componentId:components.find(row=>row.system_key==='base_pay')!.id,amount:'1000'}})
      assert.deepEqual((await calculatePayRun(command)).errors,[])
      await withOrgTransaction(orgId,async()=>{
        await prepareWithholdingRecordWrite({orgId,actorId,employeePartyId:employeeId,effectiveFrom:'2026-05-01',protectCommittedHistory:true})
        await db.execute(sql`update employee_tax_certificates set superseded_on='2026-05-01',updated_at=clock_timestamp() where org_id=${orgId} and employee_party_id=${employeeId} and certificate_key='ca_t4127_method' and superseded_on is null`)
        await db.execute(sql`insert into employee_tax_certificates(org_id,employee_party_id,country,certificate_key,answers,effective_from,created_by,updated_by)
          values(${orgId},${employeeId},'CA','ca_t4127_method','{"method":"option2","reason":"Employer elected cumulative withholding for uneven pay"}'::jsonb,'2026-05-01',${actorId},${actorId})`)
      })
      await assert.rejects(commitPayRun(command),/recalculate/i)
      assert.deepEqual((await calculatePayRun(command)).errors,[])
      await commitPayRun(command)
    })
  }finally{await withBypassContext(()=>dropScratchOrgReporting(orgId))}
  const imported=await withBypassContext(()=>seedAdoption())
  try{
    await withBypassContext(async()=>{
      await db.execute(sql`update employee_payroll_profiles set cpp_exempt=true,ei_exempt=true where org_id=${imported.orgId} and employee_party_id=${imported.employeeId}`)
      await db.execute(sql`insert into employee_tax_certificates(org_id,employee_party_id,country,certificate_key,answers,effective_from,created_by,updated_by)
        values(${imported.orgId},${imported.employeeId},'CA','ca_t4127_method','{"method":"option2","reason":"Employer elected cumulative withholding for uneven pay","window_start":"2026-01-01","opening_history_through":"2026-09-29","opening_history_complete":"true"}'::jsonb,'2026-10-01',${imported.actorId},${imported.actorId})`)
    })
    await withOrgContext(imported.orgId,async()=>{
      const saved=await saveOpeningBalances({orgId:imported.orgId,actorId:imported.actorId,taxYear:2026,rows:[{employeePartyId:imported.employeeId,amounts:{taxableYtd:'20000',taxYtd:'1390',caAvgIncome:'20000',caAvgTaxM:'1390'}}]})
      assert.deepEqual(saved.errors,[]);assert.equal(saved.created,1)
      const created=await createPayRun({orgId:imported.orgId,actorId:imported.actorId,payScheduleId:imported.scheduleId,periodStart:'2026-09-27',periodEnd:'2026-10-10',payDate:'2026-10-13'})
      const command={orgId:imported.orgId,actorId:imported.actorId,documentId:created.documentId}
      const component=(await db.execute<{id:string}>(sql`select id from pay_components where org_id=${imported.orgId} and system_key='base_pay'`)).rows[0]!
      await mutatePayRunAdjustment({...command,mutation:{action:'add',employeePartyId:imported.employeeId,componentId:component.id,amount:'500'}})
      assert.deepEqual((await calculatePayRun(command)).errors,[])
      const factors=(await db.execute<{factors:Record<string,string>}>(sql`select factors from pay_stubs where org_id=${imported.orgId} and pay_run_document_id=${created.documentId}`)).rows[0]!.factors
      // CRA's 20,000 + 500 at 26/21 gives A=25,380.95 (exactly 25,380.952381,
      // traced at ledger precision). Actual 2026 Ontario tax is 1,965.71;
      // 21/26 gives 1,587.69, less M=1,390.
      assert.equal(factors.S1_DEN,'21.0000');assert.equal(factors.A,'25380.9524');assert.equal(factors.M,'1390.0000');assert.equal(factors.T,'197.6900')
      await commitPayRun(command)
    })
  }finally{await withBypassContext(()=>dropScratchOrgReporting(imported.orgId))}
})

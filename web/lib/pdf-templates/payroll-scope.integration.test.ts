import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '../locale' && context.parentURL?.includes('/pdf-templates/values')) return {shortCircuit:true,url:'data:text/javascript,export async function resolveLocale(){return "en-CA"}'}
    if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    return next(specifier, context)
  },
})
const { sql } = await import('drizzle-orm')
const { db } = await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, dropScratchOrgReporting, seedFlowActors } = await import('@openbooks/engine/src/test-fixtures.ts')
const { createPayRun } = await import('@openbooks/engine/src/payroll-run.ts')
const { findSamplePdfRecordId, loadPdfRecordValues } = await import('./values')
const { loadRecordSubsidiaryScope } = await import('../../app/api/record-pdf/lib')
const { guardSubsidiaryScope } = await import('../authz')
type Authz = import('../authz').Authz

for (const recordType of ['pay_stub', 'payroll_cheque'] as const) {
  test(`${recordType} PDF scope follows the original pay-run entity for printing and preview`, {skip:!process.env.OPENBOOKS_DB_URL}, async()=>{
    const org = await createScratchOrg()
    const other = await createScratchOrg()
    try {
      const {adminId} = await seedFlowActors(org.orgId)
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"payroll":true}'::jsonb) where id=${org.orgId}`)
      const hidden = randomUUID()
      await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
        values(${hidden},${org.orgId},${org.subsidiaryId},'Hidden payroll entity','CAD','CA')`)
      const stubs: string[]=[]
      const employees: string[]=[]
      for(const [sub,name,date] of [[org.subsidiaryId,'Visible','2026-07-01T00:00:00Z'],[hidden,'Hidden','2026-07-02T00:00:00Z']] as const) {
        const schedule = randomUUID(), employee=randomUUID(), stub=randomUUID()
        await db.execute(sql`insert into pay_schedules(id,org_id,name,frequency,periods_per_year,anchor_period_end,pay_date_offset_days,subsidiary_id)
          values(${schedule},${org.orgId},${name},'biweekly',26,'2026-07-18',3,${sub})`)
        await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id)
          values(${employee},${org.orgId},'person',${name},${sub})`)
        const run=await createPayRun({orgId:org.orgId,actorId:adminId,payScheduleId:schedule,periodStart:'2026-07-05',periodEnd:'2026-07-18'})
        await db.execute(sql`insert into pay_stubs(id,org_id,pay_run_document_id,employee_party_id,province,periods_per_year,pay_date,tax_year,currency_code,gross,net_pay,payment_method,cheque_number,created_at)
          values(${stub},${org.orgId},${run.documentId},${employee},'ON',26,'2026-07-21',2026,'CAD',240,200,'cheque',${name},${date}::timestamptz)`)
        stubs.push(stub);employees.push(employee)
      }
      const gate={user:{orgId:org.orgId,id:adminId},permissions:new Set(['payroll.read']),allowedSubsidiaryIds:new Set([org.subsidiaryId])} as Authz
      const visible = await loadRecordSubsidiaryScope(recordType,org.orgId,stubs[0]!)
      assert.deepEqual(visible,{subsidiaryId:org.subsidiaryId})
      assert.equal(guardSubsidiaryScope(gate,visible!.subsidiaryId),null)
      const denied = await loadRecordSubsidiaryScope(recordType,org.orgId,stubs[1]!)
      assert.equal(guardSubsidiaryScope(gate,denied!.subsidiaryId)?.status,404)
      assert.equal(await findSamplePdfRecordId(recordType,org.orgId,new Set([org.subsidiaryId])),stubs[0])
      assert.equal(await findSamplePdfRecordId(recordType,org.orgId,null),stubs[1])
      assert.equal(await findSamplePdfRecordId(recordType,org.orgId,new Set()),null)
      assert.equal(await loadRecordSubsidiaryScope(recordType,other.orgId,stubs[0]!),null)
      assert.equal(await loadRecordSubsidiaryScope(recordType,org.orgId,randomUUID()),null)
      // A later employee transfer cannot move the original pay-run document.
      await db.execute(sql`update parties set subsidiary_id=${hidden} where org_id=${org.orgId} and id=${employees[0]}`)
      await db.execute(sql`update parties set subsidiary_id=${org.subsidiaryId} where org_id=${org.orgId} and id=${employees[1]}`)
      assert.deepEqual(await loadRecordSubsidiaryScope(recordType,org.orgId,stubs[0]!),visible)
      assert.equal(await findSamplePdfRecordId(recordType,org.orgId,new Set([org.subsidiaryId])),stubs[0])
    } finally {await dropScratchOrgReporting(org.orgId);await dropScratchOrgReporting(other.orgId)}
  })
}


test('pay-stub YTD cannot disclose another legal entity or add another currency', {skip:!process.env.OPENBOOKS_DB_URL},async()=>{
 const org=await createScratchOrg()
 try {
  const {adminId}=await seedFlowActors(org.orgId)
  const hidden=randomUUID(),employee=randomUUID()
  await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"payroll":true}'::jsonb) where id=${org.orgId}`)
  await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values(${hidden},${org.orgId},${org.subsidiaryId},'Other employer','CAD','CA')`)
  await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id) values(${employee},${org.orgId},'person','Transferred employee',${org.subsidiaryId})`)
  let ownStub=''
  for(const [sub,currency,gross,tax] of [[org.subsidiaryId,'CAD','240','10'],[org.subsidiaryId,'CAD','60','5'],[hidden,'CAD','1000','100'],[org.subsidiaryId,'USD','2000','200']] as const) {
   const schedule=randomUUID(),stub=randomUUID()
   await db.execute(sql`insert into pay_schedules(id,org_id,name,frequency,periods_per_year,anchor_period_end,pay_date_offset_days,subsidiary_id)
    values(${schedule},${org.orgId},${schedule},'biweekly',26,'2026-07-18',3,${sub})`)
   const run=await createPayRun({orgId:org.orgId,actorId:adminId,payScheduleId:schedule,periodStart:'2026-07-05',periodEnd:'2026-07-18'})
   await db.execute(sql`insert into pay_stubs(id,org_id,pay_run_document_id,employee_party_id,province,periods_per_year,pay_date,tax_year,currency_code,gross,net_pay,factors)
    values(${stub},${org.orgId},${run.documentId},${employee},'ON',26,'2026-07-21',2026,${currency},${gross},${gross},${JSON.stringify({T:tax})}::jsonb)`)
   await db.execute(sql`update pay_runs set run_status='committed' where org_id=${org.orgId} and document_id=${run.documentId}`)
   if(sub===org.subsidiaryId&&currency==='CAD'&&!ownStub) ownStub=stub
  }
  const record=await loadPdfRecordValues('pay_stub',org.orgId,ownStub)
  assert.ok(record)
  assert.equal(record.values.ytd_gross,'$300.00')
  assert.equal(record.values.ytd_net,'$300.00')
  assert.equal(record.values.ytd_tax,'$15.00')
 } finally {await dropScratchOrgReporting(org.orgId)}
})

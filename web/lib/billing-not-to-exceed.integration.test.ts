import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
registerHooks({resolve(specifier,context,next){
  if (specifier === 'server-only') return {shortCircuit:true,url:'data:text/javascript,export {}'}
  return next(specifier,context)
}})
const { db, withBypassContext } = await import('@openbooks/engine/src/db.ts')
const { sql } = await import('drizzle-orm')
const { BUILTIN_PROJECT_TYPES } = await import('@openbooks/schema')
const { createScratchOrg, seedFlowActors, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { generateInvoiceFromBillingRequest } = await import('./billing')
const { createBillingRequest } = await import('./billing-requests')

const total = async (orgId: string, id: string) =>
  (await db.execute<{total:string}>(sql`select total::text from documents where org_id=${orgId} and id=${id}`)).rows[0]!.total

/**
 * The not-to-exceed cap bounds the CUMULATIVE amount invoiced on the project.
 * A draft invoice already reserves the amount it will bill, so two open
 * requests cannot each draw the full remaining capacity; credits restore it.
 */
test('not-to-exceed counts draft invoices and nets credits under the cap', {skip:!process.env.OPENBOOKS_DB_URL}, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId
      const tm = BUILTIN_PROJECT_TYPES.find((t) => t.key === 'time_and_materials')!
      const typeId = randomUUID(), project = randomUUID()
      await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
        values (${typeId},${org.orgId},'capped_tm','Capped T&M','time_and_materials',
                ${JSON.stringify({ ...tm.invoicingProfile, notToExceed: true })}::jsonb,${JSON.stringify(tm.backupProfile)}::jsonb)`)
      await db.execute(sql`insert into project_financial_profile_versions(org_id,project_type_id,effective_from,financial_profile,reason)
        values (${org.orgId},${typeId},'2000-01-01',${JSON.stringify(tm.financialProfile)}::jsonb,'scratch fixture baseline')`)
      await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,contract_value,status,is_active,custom)
        values (${project},${org.orgId},${org.subsidiaryId},'NTE','Not to exceed',${org.customerId},${typeId},'100000.0000','active',true,'{}'::jsonb)`)
      const request = (drawAmount: string) =>
        createBillingRequest(org.orgId, actor, {projectId: project, basis: 'draw_amount', drawAmount, cutoffDate: org.date, backupRequired: false})

      const first = await generateInvoiceFromBillingRequest(org.orgId, actor, (await request('90000')).id)
      assert.equal(await total(org.orgId, first.id), '90000.0000')
      // Second draft while the first is still a draft: only 10,000 of capacity remains.
      const second = await generateInvoiceFromBillingRequest(org.orgId, actor, (await request('90000')).id)
      assert.equal(await total(org.orgId, second.id), '10000.0000')
      await assert.rejects(generateInvoiceFromBillingRequest(org.orgId, actor, (await request('1')).id), /fully invoiced/)

      // A credit on the project restores capacity.
      const credit = randomUUID()
      await db.execute(sql`insert into documents(id,org_id,kind,document_number,party_id,subsidiary_id,project_id,document_date,currency,status,subtotal,tax_total,total)
        values (${credit},${org.orgId},'customer_credit','CR-NTE',${org.customerId},${org.subsidiaryId},${project},${org.date},'CAD','draft','30000','0','30000')`)
      await db.execute(sql`insert into document_lines(org_id,document_id,line_number,account_id,description,quantity,unit_price,amount)
        values (${org.orgId},${credit},1,${org.accounts.revenue},'Credit',1,'30000','30000')`)
      await db.execute(sql`update documents set status='approved' where org_id=${org.orgId} and id=${credit}`)
      const third = await generateInvoiceFromBillingRequest(org.orgId, actor, (await request('50000')).id)
      assert.equal(await total(org.orgId, third.id), '30000.0000')

      // A voided invoice releases its reservation; nothing else does.
      await db.execute(sql`update documents set status='voided', voided_at=now(), voided_by=${actor}, void_reason='regression: release reservation' where org_id=${org.orgId} and id=${second.id}`)
      const fourth = await generateInvoiceFromBillingRequest(org.orgId, actor, (await request('50000')).id)
      assert.equal(await total(org.orgId, fourth.id), '10000.0000')
    } finally { await dropScratchOrg(org.orgId) }
  })
})

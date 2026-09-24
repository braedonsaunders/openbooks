import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
registerHooks({resolve(specifier,context,next){
  if (specifier === 'server-only') return {shortCircuit:true,url:'data:text/javascript,export {}'}
  return next(specifier,context)
}})
const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, seedFlowActors, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { generateInvoiceFromBillingRequest } = await import('./billing')
const { createBillingRequest } = await import('./billing-requests')

// Per-item grouping merges every source cost line into one presented line
// and stamps each source with its invoice line, so a retry (or a second
// request over the same project) can never charge either source again.
test('per-item grouping bills every source cost line exactly once across runs', async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      await db.execute(sql`update orgs set settings = jsonb_set(settings, '{controlAccounts,projectRevenue}', to_jsonb(${org.accounts.revenue}::text), true) where id = ${org.orgId}`)
      const actor = (await seedFlowActors(org.orgId)).adminId
      const project = randomUUID(), cost = randomUUID(), line1 = randomUUID(), line2 = randomUUID()
      await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active,custom,invoicing_profile) values (${project},${org.orgId},${org.subsidiaryId},'PERITEM','Per-item provenance',${org.customerId},'active',true,'{}'::jsonb,'{"lineGrouping":"per_item"}'::jsonb)`)
      await db.execute(sql`insert into documents(id,org_id,kind,document_number,party_id,subsidiary_id,project_id,document_date,posting_date,currency,fx_rate,status,subtotal,tax_total,total) values (${cost},${org.orgId},'vendor_bill','PERITEM-COST',${org.vendorId},${org.subsidiaryId},${project},${org.date},${org.date},'CAD',1,'draft','20','0','20')`)
      await db.execute(sql`insert into document_lines(id,org_id,document_id,line_number,item_id,account_id,description,quantity,unit_price,amount,is_billable) values (${line1},${org.orgId},${cost},1,${org.items.service},${org.accounts.cogs},'First cost',1,'10','10',true),(${line2},${org.orgId},${cost},2,${org.items.service},${org.accounts.cogs},'Second cost',1,'10','10',true)`)
      await db.execute(sql`update documents set status='approved' where id=${cost} and org_id=${org.orgId}`)

      const req1 = await createBillingRequest(org.orgId,actor,{projectId:project,basis:'date_range',cutoffDate:org.date,backupRequired:false})
      const invoice1 = await generateInvoiceFromBillingRequest(org.orgId,actor,req1.id)
      const lines1 = (await db.execute<{amount:string}>(sql`select amount::text from document_lines where org_id=${org.orgId} and document_id=${invoice1.id} order by line_number`)).rows
      assert.deepEqual(lines1.map((l) => l.amount), ['20.0000'], 'matching item costs combine into one invoice line with the full source amount')
      const stamped = (await db.execute<{count:string}>(sql`select count(*)::text as count from document_lines where org_id=${org.orgId} and id in (${line1},${line2}) and billed_by_line_id is not null`)).rows[0]!
      assert.equal(stamped.count, '2', 'both sources carry their invoice line')

      const req2 = await createBillingRequest(org.orgId,actor,{projectId:project,basis:'date_range',cutoffDate:org.date,backupRequired:false})
      await assert.rejects(
        generateInvoiceFromBillingRequest(org.orgId,actor,req2.id),
        /Nothing available to bill/,
        'a second run over stamped sources refuses instead of billing anything new',
      )
      const billed = (await db.execute<{total:string}>(sql`select coalesce(sum(total),0)::text as total from documents where org_id=${org.orgId} and kind='customer_invoice'`)).rows[0]!
      assert.equal(billed.total, '20.0000', 'both runs together bill the sources exactly once')
    } finally { await dropScratchOrg(org.orgId) }
  })
})

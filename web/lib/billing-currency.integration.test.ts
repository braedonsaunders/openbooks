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
const { createScratchOrg, seedFlowActors, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { generateInvoiceFromBillingRequest } = await import('./billing')
const { createBillingRequest } = await import('./billing-requests')

for (const [currency, amount, expected] of [['JPY','100.5000','101.0000'],['JPY','-100.5000','-101.0000'],['CAD','100.5550','100.5600']] as const) {
  test(`project billing rounds ${currency} ${amount} to payable precision`, {skip:!process.env.OPENBOOKS_DB_URL}, async () => {
    await withBypassContext(async () => {
      const org = await createScratchOrg()
      try {
        const actors = await seedFlowActors(org.orgId)
        const project = randomUUID()
        await db.execute(sql`update subsidiaries set base_currency=${currency} where id=${org.subsidiaryId} and org_id=${org.orgId}`)
        await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active,custom) values (${project},${org.orgId},${org.subsidiaryId},'ROUND','Currency precision',${org.customerId},'active',true,'{}'::jsonb)`)
        const req = await createBillingRequest(org.orgId,actors.adminId,{projectId:project,basis:'draw_amount',drawAmount:amount,cutoffDate:org.date,backupRequired:false})
        const invoice = await generateInvoiceFromBillingRequest(org.orgId,actors.adminId,req.id)
        const row = (await db.execute<{currency:string,total:string,amount:string,unit_price:string}>(sql`select d.currency,d.total::text,l.amount::text,l.unit_price::text from documents d join document_lines l on l.document_id=d.id and l.org_id=d.org_id where d.org_id=${org.orgId} and d.id=${invoice.id}`)).rows[0]!
        assert.deepEqual(row,{currency,total:expected,amount:expected,unit_price:expected+'0000'})
        await assert.rejects(generateInvoiceFromBillingRequest(org.orgId,actors.adminId,req.id),/already been invoiced/)
      } finally { await dropScratchOrg(org.orgId) }
    })
  })
}

for (const [markupPercent, expected] of [['1.2345','101234.5000'],['-10','90000.0000'],['invalid',null]] as const) {
  test(`project billing preserves markup ${markupPercent} or refuses invalid configuration`, {skip:!process.env.OPENBOOKS_DB_URL}, async () => {
    await withBypassContext(async () => {
      const org = await createScratchOrg()
      try {
        const actor = (await seedFlowActors(org.orgId)).adminId
        const project = randomUUID(), cost = randomUUID(), line = randomUUID()
        await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active,custom) values (${project},${org.orgId},${org.subsidiaryId},'MARKUP','Exact markup',${org.customerId},'active',true,${JSON.stringify({markupPercent})}::jsonb)`)
        await db.execute(sql`insert into documents(id,org_id,kind,document_number,party_id,subsidiary_id,project_id,document_date,posting_date,currency,fx_rate,status,subtotal,tax_total,total) values (${cost},${org.orgId},'vendor_bill','MARKUP-COST',${org.vendorId},${org.subsidiaryId},${project},${org.date},${org.date},'CAD',1,'draft','100000','0','100000')`)
        await db.execute(sql`insert into document_lines(id,org_id,document_id,line_number,account_id,description,quantity,unit_price,amount,is_billable) values (${line},${org.orgId},${cost},1,${org.accounts.cogs},'Billable expense',1,'100000','100000',true)`)
        await db.execute(sql`update documents set status='approved' where id=${cost} and org_id=${org.orgId}`)
        const req = await createBillingRequest(org.orgId,actor,{projectId:project,basis:'date_range',cutoffDate:org.date,backupRequired:false})
        if (expected === null) {
          await assert.rejects(generateInvoiceFromBillingRequest(org.orgId,actor,req.id),/markup/i)
          const row=(await db.execute<{status:string,billed_by_line_id:string|null}>(sql`select r.status,l.billed_by_line_id from billing_requests r join document_lines l on l.org_id=r.org_id and l.id=${line} where r.org_id=${org.orgId} and r.id=${req.id}`)).rows[0]!
          assert.deepEqual(row,{status:'open',billed_by_line_id:null})
        } else {
          const invoice = await generateInvoiceFromBillingRequest(org.orgId,actor,req.id)
          assert.equal((await db.execute<{total:string}>(sql`select total::text from documents where org_id=${org.orgId} and id=${invoice.id}`)).rows[0]!.total,expected)
        }
      } finally { await dropScratchOrg(org.orgId) }
    })
  })
}

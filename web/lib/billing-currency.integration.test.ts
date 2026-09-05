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

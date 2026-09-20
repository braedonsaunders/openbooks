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
const { BUILTIN_PROJECT_TYPES } = await import('@openbooks/schema')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const wip = await import('./wip-billing')

const enabled = { skip: !process.env.OPENBOOKS_DB_URL }

/**
 * The NTE capacity query binds the profile's doc/credit kinds as a text[]
 * literal. A kind containing a comma must stay ONE array element: if the
 * literal builder splits it, the capacity counts document kinds the profile
 * never named and the not-to-exceed cap enforces against the wrong set.
 */
test('contract capacity keeps a comma-bearing doc kind as one array element', enabled, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      const tm = BUILTIN_PROJECT_TYPES.find((t) => t.key === 'time_and_materials')!
      const typeId = randomUUID(), project = randomUUID(), doc = randomUUID(), line = randomUUID()
      await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
        values (${typeId},${org.orgId},'time_and_materials','Time & Materials','time_and_materials',${JSON.stringify(tm.invoicingProfile)}::jsonb,${JSON.stringify(tm.backupProfile)}::jsonb)`)
      await db.execute(sql`insert into project_financial_profile_versions(org_id,project_type_id,effective_from,financial_profile,reason)
        values (${org.orgId},${typeId},'2000-01-01',${JSON.stringify(tm.financialProfile)}::jsonb,'capacity fixture')`)
      await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,status,is_active,custom)
        values (${project},${org.orgId},${org.subsidiaryId},'WIP-CAP','Capacity job',${org.customerId},${typeId},'active',true,'{}'::jsonb)`)
      await db.execute(sql`insert into documents(id,org_id,kind,document_number,party_id,subsidiary_id,project_id,document_date,posting_date,currency,fx_rate,status,subtotal,tax_total,total)
        values (${doc},${org.orgId},'customer_invoice',${'INV-'+doc},${org.customerId},${org.subsidiaryId},${project},${org.date},${org.date},'CAD',1,'draft','1000','0','1000')`)
      await db.execute(sql`insert into document_lines(id,org_id,document_id,line_number,item_id,account_id,description,quantity,unit_price,amount,is_billable,project_id)
        values (${line},${org.orgId},${doc},1,${org.items.service},${org.accounts.cogs},'Billed service',1,'1000','1000',true,${project})`)
      await db.execute(sql`update documents set status='approved' where org_id=${org.orgId} and id=${doc}`)

      // Control: the plain kind counts the posted invoice.
      assert.equal(
        await wip.projectContractCapacityUsed(db, org.orgId, project, { docKinds: ['customer_invoice'], creditKinds: [] }),
        '1000.0000',
      )
      // A single kind that merely CONTAINS a comma names no real document
      // kind, so capacity must be zero — not the invoice the split would match.
      assert.equal(
        await wip.projectContractCapacityUsed(db, org.orgId, project, { docKinds: ['customer_invoice,phantom'], creditKinds: [] }),
        '0.0000',
      )
    } finally { await dropScratchOrg(org.orgId) }
  })
})

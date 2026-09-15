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
const wip = await import('./wip-billing')

const enabled = { skip: !process.env.OPENBOOKS_DB_URL }

/**
 * A credit is not prebillable: prebill lines carry a non-negative CHECK, so a
 * credit-only worksheet can never persist. Creation must fail closed with a
 * domain error — not sweep the credit into an INSERT that dies on the schema
 * CHECK and surfaces as a 500.
 */
test('a credit-only project fails prebill creation with a domain error', enabled, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,wipBilling}', 'true'::jsonb, true) where id = ${org.orgId}`)
      const preparer = (await seedFlowActors(org.orgId)).adminId
      const tm = BUILTIN_PROJECT_TYPES.find((t) => t.key === 'time_and_materials')!
      const financialProfile = {
        ...tm.financialProfile,
        billableValue: { ...tm.financialProfile.billableValue, costSourceKinds: ['vendor_bill', 'vendor_credit'] },
      }
      const typeId = randomUUID(), project = randomUUID(), doc = randomUUID(), line = randomUUID()
      await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
        values (${typeId},${org.orgId},'time_and_materials','Time & Materials','time_and_materials',${JSON.stringify(tm.invoicingProfile)}::jsonb,${JSON.stringify(tm.backupProfile)}::jsonb)`)
      await db.execute(sql`insert into project_financial_profile_versions(org_id,project_type_id,effective_from,financial_profile,reason)
        values (${org.orgId},${typeId},'2000-01-01',${JSON.stringify(financialProfile)}::jsonb,'credit fixture')`)
      await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,status,is_active,custom)
        values (${project},${org.orgId},${org.subsidiaryId},'WIP-CR','Credit-only job',${org.customerId},${typeId},'active',true,'{}'::jsonb)`)
      await db.execute(sql`insert into documents(id,org_id,kind,document_number,party_id,subsidiary_id,project_id,document_date,posting_date,currency,fx_rate,status,subtotal,tax_total,total)
        values (${doc},${org.orgId},'vendor_credit',${'CR-'+doc},${org.vendorId},${org.subsidiaryId},${project},${org.date},${org.date},'CAD',1,'draft','100','0','100')`)
      await db.execute(sql`insert into document_lines(id,org_id,document_id,line_number,item_id,account_id,description,quantity,unit_price,amount,is_billable)
        values (${line},${org.orgId},${doc},1,${org.items.service},${org.accounts.cogs},'Refunded service',1,'100','100',true)`)
      await db.execute(sql`update documents set status='approved' where org_id=${org.orgId} and id=${doc}`)

      await assert.rejects(
        wip.createPrebill(org.orgId, preparer, { projectId: project, periodEnd: org.date }, null),
        (error: unknown) => error instanceof wip.WipBillingError,
      )
      assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from wip_prebills where org_id=${org.orgId}`)).rows[0]!.n, 0)
    } finally { await dropScratchOrg(org.orgId) }
  })
})

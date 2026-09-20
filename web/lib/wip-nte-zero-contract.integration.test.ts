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
const { createScratchOrg, seedFlowActors, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const wip = await import('./wip-billing')

const enabled = { skip: !process.env.OPENBOOKS_DB_URL }

/**
 * An NTE job whose contract ceiling was never entered has an UNKNOWN cap, not
 * a zero cap. Billing-request invoicing and Financials both read it that way
 * (no ceiling ⇒ no cap); WIP prebilling must agree instead of refusing every
 * worksheet while a real ceiling blocks nothing elsewhere. A consumed ceiling
 * still blocks.
 */
test('NTE prebilling treats an unset contract ceiling as no cap', enabled, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,wipBilling}', 'true'::jsonb, true) where id = ${org.orgId}`)
      const preparer = (await seedFlowActors(org.orgId)).adminId
      const nte = BUILTIN_PROJECT_TYPES.find((t) => t.key === 'not_to_exceed')!
      const typeId = randomUUID()
      await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
        values (${typeId},${org.orgId},'not_to_exceed','Not-to-Exceed','time_and_materials',${JSON.stringify(nte.invoicingProfile)}::jsonb,${JSON.stringify(nte.backupProfile)}::jsonb)`)
      await db.execute(sql`insert into project_financial_profile_versions(org_id,project_type_id,effective_from,financial_profile,reason)
        values (${org.orgId},${typeId},'2000-01-01',${JSON.stringify(nte.financialProfile)}::jsonb,'nte cap fixture')`)
      const employee = randomUUID()
      await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
        values (${employee},${org.orgId},'employee','Cap Hand',${org.subsidiaryId},true,'{}'::jsonb)`)
      const setup = async (code: string, contractValue: string | null) => {
        const project = randomUUID(), entry = randomUUID()
        await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,contract_value,status,is_active,custom)
          values (${project},${org.orgId},${org.subsidiaryId},${code},${code},${org.customerId},${typeId},${contractValue},'active',true,'{}'::jsonb)`)
        await db.execute(sql`insert into time_entries(id,org_id,employee_party_id,worked_on,hours,status,is_billable,billing_status,bill_rate,project_id)
          values (${entry},${org.orgId},${employee},${org.date},'8','approved',true,'unbilled','100',${project})`)
        return project
      }

      // No ceiling entered: the unbilled time prebills like any uncapped job.
      const open = await setup('NTE-OPEN', null)
      const prebill = await wip.createPrebill(org.orgId, preparer, { projectId: open, periodEnd: org.date }, null)
      assert.ok(prebill.id)
      assert.equal(prebill.sourceCount, 1)

      // A consumed ceiling still blocks: 100 of contract, 100 already invoiced.
      const capped = await setup('NTE-CAPPED', '100.0000')
      const doc = randomUUID(), line = randomUUID()
      await db.execute(sql`insert into documents(id,org_id,kind,document_number,party_id,subsidiary_id,project_id,document_date,currency,status,subtotal,tax_total,total)
        values (${doc},${org.orgId},'customer_invoice',${'INV-'+doc},${org.customerId},${org.subsidiaryId},${capped},${org.date},'CAD','draft','100','0','100')`)
      await db.execute(sql`insert into document_lines(id,org_id,document_id,line_number,account_id,description,quantity,unit_price,amount,is_billable,project_id)
        values (${line},${org.orgId},${doc},1,${org.accounts.revenue},'Billed',1,'100','100',true,${capped})`)
      await assert.rejects(
        wip.createPrebill(org.orgId, preparer, { projectId: capped, periodEnd: org.date }, null),
        /not-to-exceed contract cap/,
      )
    } finally { await dropScratchOrg(org.orgId) }
  })
})

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
 * Two tabs editing the same draft prebill line: the second save carries the
 * revision token it read before the first save committed, so it must fail
 * with a 409 instead of silently overwriting the first tab's billed amount.
 * (Budget worksheet cells mandate expectedRevision; prebill lines are the
 * same worksheet class and must too.)
 */
test('a stale prebill-line revision refuses instead of overwriting a newer adjustment', enabled, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,wipBilling}', 'true'::jsonb, true) where id = ${org.orgId}`)
      const preparer = (await seedFlowActors(org.orgId)).adminId
      const tm = BUILTIN_PROJECT_TYPES.find((t) => t.key === 'time_and_materials')!
      const typeId = randomUUID(), project = randomUUID(), employee = randomUUID()
      await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
        values (${typeId},${org.orgId},'time_and_materials','Time & Materials','time_and_materials',${JSON.stringify(tm.invoicingProfile)}::jsonb,${JSON.stringify(tm.backupProfile)}::jsonb)`)
      await db.execute(sql`insert into project_financial_profile_versions(org_id,project_type_id,effective_from,financial_profile,reason)
        values (${org.orgId},${typeId},'2000-01-01',${JSON.stringify(tm.financialProfile)}::jsonb,'revision fixture')`)
      await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,status,is_active,custom)
        values (${project},${org.orgId},${org.subsidiaryId},'WIP-REV','Revision job',${org.customerId},${typeId},'active',true,'{}'::jsonb)`)
      await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id) values (${employee},${org.orgId},'employee','Revision worker',${org.subsidiaryId})`)
      await db.execute(sql`insert into time_entries(id,org_id,employee_party_id,worked_on,hours,project_id,item_id,is_billable,status,bill_rate,bill_rate_currency)
        values (${randomUUID()},${org.orgId},${employee},${org.date},'2.0000',${project},${org.items.service},true,'approved','100.0000','CAD')`)

      const prebill = await wip.createPrebill(org.orgId, preparer, { projectId: project, periodEnd: org.date }, null)
      const first = (await wip.loadPrebill(org.orgId, prebill.id, null))!.lines[0]!
      const staleToken = first.updatedAt

      // Tab A saves with the fresh token.
      const tabA = await wip.updatePrebillLine(org.orgId, preparer, prebill.id, first.id, {
        proposedBillAmount: '250',
        adjustmentReason: 'Write-up for out-of-scope work',
        adjustmentEvidence: ['client email'],
      }, null, { expectedRevision: staleToken })
      assert.equal(tabA.proposedBillAmount, '250.0000')

      // Tab B still holds the pre-A token: it must lose loudly, and the live
      // amount must stay exactly what tab A wrote.
      await assert.rejects(
        wip.updatePrebillLine(org.orgId, preparer, prebill.id, first.id, {
          proposedBillAmount: '50',
          adjustmentReason: 'Discount the client insists on',
          adjustmentEvidence: ['phone call'],
        }, null, { expectedRevision: staleToken }),
        (error: unknown) => error instanceof wip.WipBillingError && (error as { status?: number }).status === 409,
      )
      const live = (await wip.loadPrebill(org.orgId, prebill.id, null))!.lines[0]!
      assert.equal(live.proposedBillAmount, '250.0000')
    } finally { await dropScratchOrg(org.orgId) }
  })
})

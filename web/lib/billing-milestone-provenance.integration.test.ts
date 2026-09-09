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

/**
 * A milestone invoice may claim only the schedule rows it actually billed.
 * Zero-amount (not yet priced) milestones are skipped as invoice lines, so
 * stamping them with the request id would consume them without ever billing
 * them — and provenance release only unwinds on void/delete, so they would be
 * stranded for good.
 */
test('milestone billing stamps provenance only on the schedule rows it billed', {skip:!process.env.OPENBOOKS_DB_URL}, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      const unbilledReceivable = randomUUID()
      await db.execute(sql`insert into accounts(id,org_id,number,name,type,is_summary,is_active) values (${unbilledReceivable},${org.orgId},'1150','Unbilled Receivable','asset_current_other',false,true)`)
      await db.execute(sql`update orgs set settings = jsonb_set(settings, '{controlAccounts,unbilledReceivable}', to_jsonb(${unbilledReceivable}::text), true) where id = ${org.orgId}`)
      const actor = (await seedFlowActors(org.orgId)).adminId
      const fixed = BUILTIN_PROJECT_TYPES.find((t) => t.key === 'fixed_price')!
      const typeId = randomUUID(), project = randomUUID()
      await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
        values (${typeId},${org.orgId},'fixed_price','Fixed Price','fixed_price',${JSON.stringify(fixed.invoicingProfile)}::jsonb,${JSON.stringify(fixed.backupProfile)}::jsonb)`)
      await db.execute(sql`insert into project_financial_profile_versions(org_id,project_type_id,effective_from,financial_profile,reason)
        values (${org.orgId},${typeId},'2000-01-01',${JSON.stringify(fixed.financialProfile)}::jsonb,'scratch fixture baseline')`)
      await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,status,is_active,custom)
        values (${project},${org.orgId},${org.subsidiaryId},'MILESTONE','Milestone provenance',${org.customerId},${typeId},'active',true,'{}'::jsonb)`)
      const billed = randomUUID(), unpricedA = randomUUID(), unpricedB = randomUUID()
      await db.execute(sql`insert into billing_schedules(id,org_id,project_id,name,amount_billed,sort_order)
        values (${billed},${org.orgId},${project},'Mobilization','2500.0000',1),
               (${unpricedA},${org.orgId},${project},'Framing','0',2),
               (${unpricedB},${org.orgId},${project},'Closeout',null,3)`)

      const first = await createBillingRequest(org.orgId, actor, {projectId: project, basis: 'milestone', cutoffDate: org.date, backupRequired: false})
      const invoice = await generateInvoiceFromBillingRequest(org.orgId, actor, first.id)
      assert.equal((await db.execute<{total:string}>(sql`select total::text from documents where org_id=${org.orgId} and id=${invoice.id}`)).rows[0]!.total, '2500.0000')

      const rows = (await db.execute<{id:string; billing_request_id:string|null}>(sql`
        select id, billing_request_id from billing_schedules where org_id=${org.orgId} and project_id=${project} order by sort_order`)).rows
      assert.deepEqual(rows, [
        {id: billed, billing_request_id: first.id},
        {id: unpricedA, billing_request_id: null},
        {id: unpricedB, billing_request_id: null},
      ])

      // The skipped milestones are still open: once priced, the next request bills them.
      await db.execute(sql`update billing_schedules set amount_billed='4000.0000' where org_id=${org.orgId} and id=${unpricedA}`)
      const second = await createBillingRequest(org.orgId, actor, {projectId: project, basis: 'milestone', cutoffDate: org.date, backupRequired: false})
      const secondInvoice = await generateInvoiceFromBillingRequest(org.orgId, actor, second.id)
      assert.equal((await db.execute<{total:string}>(sql`select total::text from documents where org_id=${org.orgId} and id=${secondInvoice.id}`)).rows[0]!.total, '4000.0000')
      const after = (await db.execute<{id:string; billing_request_id:string|null}>(sql`
        select id, billing_request_id from billing_schedules where org_id=${org.orgId} and project_id=${project} order by sort_order`)).rows
      assert.deepEqual(after.map((r) => r.billing_request_id), [first.id, second.id, null])
    } finally { await dropScratchOrg(org.orgId) }
  })
})

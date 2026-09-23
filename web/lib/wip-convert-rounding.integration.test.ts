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

/**
 * WIP conversion settles whole minor units by largest remainder: two
 * approved 0.0050 draws must invoice as 0.01 + 0.00 (total 0.01), not as
 * two independently rounded 0.01 lines (total 0.02 — a total nobody
 * approved). The invoice lines sum to the approved total exactly.
 */
test('convertPrebill allocates the rounded approved total by largest remainder', {skip:!process.env.OPENBOOKS_DB_URL}, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,wipBilling}', 'true'::jsonb, true) where id = ${org.orgId}`)
      const actors = await seedFlowActors(org.orgId)
      const preparer = actors.adminId, approver = actors.approver1Id
      const tm = BUILTIN_PROJECT_TYPES.find((t) => t.key === 'time_and_materials')!
      const typeId = randomUUID(), project = randomUUID()
      await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
        values (${typeId},${org.orgId},'time_and_materials','Time & Materials','time_and_materials',${JSON.stringify(tm.invoicingProfile)}::jsonb,${JSON.stringify(tm.backupProfile)}::jsonb)`)
      await db.execute(sql`insert into project_financial_profile_versions(org_id,project_type_id,effective_from,financial_profile,reason)
        values (${org.orgId},${typeId},'2000-01-01',${JSON.stringify(tm.financialProfile)}::jsonb,'rounding fixture')`)
      await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,status,is_active,custom)
        values (${project},${org.orgId},${org.subsidiaryId},'WIPROUND','Rounding WIP job',${org.customerId},${typeId},'active',true,'{}'::jsonb)`)
      await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id) values (${randomUUID()},${org.orgId},'employee','Rounding worker',${org.subsidiaryId})`)
      const worker = (await db.execute<{id:string}>(sql`select id from parties where org_id=${org.orgId} and display_name='Rounding worker'`)).rows[0]!.id
      // Two billable hours pricing just over half a cent each.
      for (let n = 0; n < 2; n++) {
        await db.execute(sql`insert into time_entries(id,org_id,employee_party_id,worked_on,hours,project_id,item_id,is_billable,status,bill_rate,bill_rate_currency)
          values (${randomUUID()},${org.orgId},${worker},${org.date},'0.0001',${project},${org.items.service},true,'approved','50.0000','CAD')`)
      }
      const prebill = await wip.createPrebill(org.orgId, preparer, { projectId: project, periodEnd: org.date }, null)
      assert.equal(prebill.sourceCount, 2)
      const detail = await wip.loadPrebill(org.orgId, prebill.id, null)
      assert.equal(detail?.lines.length, 2)
      // Certify the finding's exact shape: two approved 0.0050 draws.
      for (const line of detail!.lines) {
        await wip.updatePrebillLine(
          org.orgId, preparer, prebill.id, line.id,
          { proposedBillAmount: '0.0050', adjustmentReason: 'rounding probe', adjustmentEvidence: ['note'] },
          null, { expectedRevision: line.updatedAt },
        )
      }
      const approved = await wip.loadPrebill(org.orgId, prebill.id, null)
      assert.equal(approved?.proposedBillAmount, '0.0100')
      await wip.transitionPrebill(org.orgId, preparer, prebill.id, 'submit', undefined, null)
      await wip.transitionPrebill(org.orgId, approver, prebill.id, 'approve', undefined, null)

      const converted = await wip.convertPrebill(org.orgId, preparer, prebill.id, null)
      assert.equal(converted.idempotent, false)
      const invoice = (await db.execute<{ subtotal: string; tax_total: string; total: string }>(sql`
        select subtotal::text as subtotal, tax_total::text as tax_total, total::text as total
          from documents where org_id = ${org.orgId} and id = ${converted.id}
      `)).rows[0]!
      assert.equal(invoice.total, '0.0100', 'the invoice total equals the approved total')
      assert.equal(invoice.tax_total, '0.0000')
      const lines = (await db.execute<{ amount: string }>(sql`
        select amount::text as amount from document_lines
         where org_id = ${org.orgId} and document_id = ${converted.id} order by line_number
      `)).rows.map((row) => row.amount)
      assert.deepEqual(lines, ['0.0100', '0.0000'])
    } finally { await dropScratchOrg(org.orgId) }
  })
})

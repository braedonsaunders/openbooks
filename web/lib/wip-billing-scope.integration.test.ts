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

/**
 * WIP prebilling is project-scoped work: every read and write must honour the
 * caller's subsidiary scope. A worksheet on a hidden project is invisible in
 * lists and analytics, unreachable by id (404 — the same answer as a missing
 * id), and cannot be created, edited, held, transitioned, or converted.
 */
test('WIP prebilling honours the caller subsidiary scope end to end', {skip:!process.env.OPENBOOKS_DB_URL}, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      const actors = await seedFlowActors(org.orgId)
      const preparer = actors.adminId, approver = actors.approver1Id
      const tm = BUILTIN_PROJECT_TYPES.find((t) => t.key === 'time_and_materials')!
      const typeId = randomUUID(), other = randomUUID(), project = randomUUID(), employee = randomUUID(), entry = randomUUID()
      await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${other},${org.orgId},${org.subsidiaryId},'Other entity','CAD','CA')`)
      await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
        values (${typeId},${org.orgId},'time_and_materials','Time & Materials','time_and_materials',${JSON.stringify(tm.invoicingProfile)}::jsonb,${JSON.stringify(tm.backupProfile)}::jsonb)`)
      await db.execute(sql`insert into project_financial_profile_versions(org_id,project_type_id,effective_from,financial_profile,reason)
        values (${org.orgId},${typeId},'2000-01-01',${JSON.stringify(tm.financialProfile)}::jsonb,'scratch fixture baseline')`)
      // The project lives in the OTHER subsidiary; the restricted caller sees only the root.
      await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,status,is_active,custom)
        values (${project},${org.orgId},${other},'WIP','Hidden WIP job',${org.customerId},${typeId},'active',true,'{}'::jsonb)`)
      await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id) values (${employee},${org.orgId},'employee','Billable worker',${other})`)
      await db.execute(sql`insert into time_entries(id,org_id,employee_party_id,worked_on,hours,project_id,item_id,is_billable,status,bill_rate,bill_rate_currency)
        values (${entry},${org.orgId},${employee},${org.date},'2.0000',${project},${org.items.service},true,'approved','100.0000','CAD')`)

      const restricted = new Set([org.subsidiaryId])
      const visible = new Set([org.subsidiaryId, other])
      const period = { projectId: project, periodEnd: org.date }
      const notFound = (error: unknown) => error instanceof wip.WipBillingError && error.status === 404

      // Reads
      assert.deepEqual((await wip.listWipProjects(org.orgId, restricted)).map((p) => p.id), [])
      assert.deepEqual((await wip.listWipProjects(org.orgId, visible)).map((p) => p.id), [project])
      assert.equal((await wip.wipAnalytics(org.orgId, org.date, restricted)).aging.current, '0')
      assert.equal((await wip.wipAnalytics(org.orgId, org.date, visible)).aging.current, '200.0000')
      // Create
      await assert.rejects(wip.createPrebill(org.orgId, preparer, period, restricted), notFound)
      assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from wip_prebills where org_id=${org.orgId}`)).rows[0]!.n, 0)
      const prebill = await wip.createPrebill(org.orgId, preparer, period, visible)
      assert.equal(prebill.sourceCount, 1)
      // Lists and by-id loads
      assert.deepEqual(await wip.listPrebills(org.orgId, undefined, restricted), [])
      assert.deepEqual(await wip.listPrebills(org.orgId, project, restricted), [])
      assert.equal((await wip.listPrebills(org.orgId, undefined, visible)).length, 1)
      assert.equal(await wip.loadPrebill(org.orgId, prebill.id, restricted), null)
      const detail = await wip.loadPrebill(org.orgId, prebill.id, visible)
      assert.equal(detail?.lines.length, 1)
      const lineId = detail!.lines[0]!.id
      // Line edits and holds
      await assert.rejects(wip.updatePrebillLine(org.orgId, preparer, prebill.id, lineId, { proposedBillAmount: '150.0000', adjustmentReason: 'scope', adjustmentEvidence: ['note'] }, restricted), notFound)
      await assert.rejects(wip.holdPrebillLine(org.orgId, preparer, prebill.id, lineId, 'Disputed', [], restricted), notFound)
      const hold = await wip.holdPrebillLine(org.orgId, preparer, prebill.id, lineId, 'Disputed', [], visible)
      await assert.rejects(wip.releaseWipHold(org.orgId, preparer, hold.id, 'Resolved', restricted), notFound)
      await wip.releaseWipHold(org.orgId, preparer, hold.id, 'Resolved', visible)
      // Workflow
      await assert.rejects(wip.transitionPrebill(org.orgId, preparer, prebill.id, 'submit', undefined, restricted), notFound)
      await wip.transitionPrebill(org.orgId, preparer, prebill.id, 'submit', undefined, visible)
      await assert.rejects(wip.transitionPrebill(org.orgId, approver, prebill.id, 'approve', undefined, restricted), notFound)
      await wip.transitionPrebill(org.orgId, approver, prebill.id, 'approve', undefined, visible)
      // Convert
      await assert.rejects(wip.convertPrebill(org.orgId, preparer, prebill.id, restricted), notFound)
      assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from documents where org_id=${org.orgId} and kind='customer_invoice'`)).rows[0]!.n, 0)
      const converted = await wip.convertPrebill(org.orgId, preparer, prebill.id, visible)
      assert.equal(converted.idempotent, false)
      // The converted worksheet stays hidden too.
      assert.equal(await wip.loadPrebill(org.orgId, prebill.id, restricted), null)
      assert.equal((await wip.wipAnalytics(org.orgId, org.date, restricted)).realization.billed, '0')
      assert.equal((await wip.wipAnalytics(org.orgId, org.date, visible)).realization.billed, '200.0000')
    } finally { await dropScratchOrg(org.orgId) }
  })
})

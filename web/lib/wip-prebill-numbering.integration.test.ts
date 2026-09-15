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
 * Worksheet numbers are unique per ORGANIZATION (wip_prebills_org_number)
 * but createPrebill serialised only per PROJECT
 * (pg_advisory_xact_lock on `wip-prebill:{org}:{project}`). Two reviewers
 * creating worksheets for DIFFERENT projects at the same time both read the
 * same org-wide max()+1 and the loser dies on the unique index (500). The
 * numbering read must serialise org-wide, like billing-request numbers do.
 */
test('concurrent prebill creates for different projects receive distinct worksheet numbers', {skip:!process.env.OPENBOOKS_DB_URL}, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,wipBilling}', 'true'::jsonb, true) where id = ${org.orgId}`)
      const actors = await seedFlowActors(org.orgId)
      const preparer = actors.adminId
      const tm = BUILTIN_PROJECT_TYPES.find((t) => t.key === 'time_and_materials')!
      const typeId = randomUUID()
      await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
        values (${typeId},${org.orgId},'time_and_materials','Time & Materials','time_and_materials',${JSON.stringify(tm.invoicingProfile)}::jsonb,${JSON.stringify(tm.backupProfile)}::jsonb)`)
      await db.execute(sql`insert into project_financial_profile_versions(org_id,project_type_id,effective_from,financial_profile,reason)
        values (${org.orgId},${typeId},'2000-01-01',${JSON.stringify(tm.financialProfile)}::jsonb,'scratch fixture baseline')`)

      // Eight projects, each with its own independent billable hours, so
      // every create has disjoint source work and the ONLY shared state is
      // the org-wide worksheet counter. Each worksheet carries enough lines
      // that the work between the max()+1 read and commit is wide: with no
      // org-wide serialisation, several writers' reads land inside another
      // writer's uncommitted window and collide on wip_prebills_org_number.
      const WRITERS = 8
      const LINES_EACH = 25
      const projectIds: string[] = []
      for (let i = 0; i < WRITERS; i++) {
        const project = randomUUID(), employee = randomUUID()
        await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,status,is_active,custom)
          values (${project},${org.orgId},${org.subsidiaryId},${`WIP-RACE-${i}`},${`Race job ${i}`},${org.customerId},${typeId},'active',true,'{}'::jsonb)`)
        await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id) values (${employee},${org.orgId},'employee',${`Race worker ${i}`},${org.subsidiaryId})`)
        for (let j = 0; j < LINES_EACH; j++) {
          await db.execute(sql`insert into time_entries(id,org_id,employee_party_id,worked_on,hours,project_id,item_id,is_billable,status,bill_rate,bill_rate_currency)
            values (${randomUUID()},${org.orgId},${employee},${org.date},'2.0000',${project},${org.items.service},true,'approved','100.0000','CAD')`)
        }
        projectIds.push(project)
      }

      const created = await Promise.all(projectIds.map((projectId) =>
        wip.createPrebill(org.orgId, preparer, { projectId, periodEnd: org.date }),
      ))
      assert.equal(created.length, WRITERS)
      for (const prebill of created) assert.equal(prebill.sourceCount, LINES_EACH)
      const numbers = created.map((prebill) => prebill.worksheetNumber).sort()
      assert.deepEqual(numbers, [
        'WIP-00001', 'WIP-00002', 'WIP-00003', 'WIP-00004',
        'WIP-00005', 'WIP-00006', 'WIP-00007', 'WIP-00008',
      ])
      assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from wip_prebills where org_id=${org.orgId}`)).rows[0]!.n, WRITERS)
    } finally { await dropScratchOrg(org.orgId) }
  })
})

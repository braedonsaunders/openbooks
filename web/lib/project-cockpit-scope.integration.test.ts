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
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { loadProject } = await import('../app/api/projects/_lib')

/**
 * The project loader behind the cockpit flyout applies the caller's subsidiary
 * scope itself, so a hidden project is a missing project for every caller —
 * the page never has to remember to check.
 */
test('loadProject hides projects outside the caller subsidiary scope', {skip:!process.env.OPENBOOKS_DB_URL}, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      const other = randomUUID(), project = randomUUID()
      await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${other},${org.orgId},${org.subsidiaryId},'Other entity','CAD','CA')`)
      await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active,custom)
        values (${project},${org.orgId},${other},'HIDDEN','Hidden cockpit',${org.customerId},'active',true,'{}'::jsonb)`)
      assert.equal((await loadProject(project, org.orgId))?.project.id, project, 'unscoped callers still load the project')
      assert.equal((await loadProject(project, org.orgId, null))?.project.id, project)
      assert.equal((await loadProject(project, org.orgId, new Set([org.subsidiaryId, other])))?.project.id, project)
      assert.equal(await loadProject(project, org.orgId, new Set([org.subsidiaryId])), null, 'hidden ⇒ missing')
      assert.equal(await loadProject(project, org.orgId, new Set()), null, 'empty scope denies everything')
    } finally { await dropScratchOrg(org.orgId) }
  })
})

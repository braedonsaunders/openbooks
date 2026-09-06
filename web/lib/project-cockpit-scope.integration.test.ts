import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'
registerHooks({resolve(specifier,context,next){
  if (specifier === 'server-only') return {shortCircuit:true,url:'data:text/javascript,export {}'}
  return next(specifier,context)
}})
const { db, withBypassContext } = await import('@openbooks/engine/src/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { loadProject } = await import('../app/api/projects/_lib')

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

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

test('the projects cockpit page and every WIP billing surface carry the caller scope', () => {
  const page = source('app/(app)/projects/page.tsx')
  assert.match(page, /loadProject\(projectId, orgId, authz\.allowedSubsidiaryIds\)/)

  const wipPage = source('app/(app)/projects/wip-billing/page.tsx')
  for (const call of ['listPrebills', 'listWipProjects', 'wipAnalytics', 'loadPrebill']) {
    assert.match(wipPage, new RegExp(`${call}\\([\\s\\S]*?authz\\.allowedSubsidiaryIds`), `${call} must receive the page caller scope`)
  }
  const routes: Array<[string, string[]]> = [
    ['app/api/wip-billing/route.ts', ['listPrebills', 'createPrebill']],
    ['app/api/wip-billing/[id]/route.ts', ['loadPrebill', 'transitionPrebill']],
    ['app/api/wip-billing/[id]/convert/route.ts', ['convertPrebill']],
    ['app/api/wip-billing/[id]/lines/[lineId]/route.ts', ['holdPrebillLine', 'updatePrebillLine']],
    ['app/api/wip-billing/holds/[id]/route.ts', ['releaseWipHold']],
    ['app/api/wip-billing/analytics/route.ts', ['wipAnalytics']],
  ]
  for (const [route, calls] of routes) {
    const src = source(route)
    for (const call of calls) {
      assert.match(src, new RegExp(`${call}\\([\\s\\S]*?gate\\.allowedSubsidiaryIds`), `${route}: ${call} must receive the route caller scope`)
    }
  }
})

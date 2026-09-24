import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { SessionUser } from '../../../../lib/auth'

const root = pathToFileURL(process.cwd() + '/').href
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __projectScopeSession: session })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__projectScopeSession.user}' }
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { sql } = await import('drizzle-orm')
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { randomUUID } = await import('node:crypto')
const detail = await import('./route')
const timeEntries = await import('./time-entries/route')

const get = (orgId: string, id: string) =>
  withOrgContext(orgId, () => detail.GET(new Request('http://scope.local/api'), { params: Promise.resolve({ id }) }))
const getTime = (orgId: string, id: string, dimensionId: string) =>
  withOrgContext(
    orgId,
    () => timeEntries.GET(new Request(`http://scope.local/api?dimension=employee&key=${dimensionId}&page=1`), { params: Promise.resolve({ id }) }),
  )

/**
 * The project detail bundle is subsidiary-scoped inside one transaction: the
 * header, its tasks, and its linked party names all answer from the same
 * committed state, and a project outside the caller's scope reads exactly
 * like a missing one. Linked parties outside the scope resolve to no name
 * rather than disclosing the row.
 */
test('project detail and time-entries enforce the caller subsidiary scope', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Scoped reader', 'reviewer'))
    await withBypassContext(() => db.execute(sql`update app_roles set permissions='["*"]'::jsonb, subsidiary_restriction=${JSON.stringify({ mode: 'list', subsidiaryIds: [org.subsidiaryId] })}::jsonb where org_id=${org.orgId} and key='reviewer'`))
    await withBypassContext(() => db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb) || '{"projects":true}'::jsonb) where id=${org.orgId}`))
    session.user = { id: actor, orgId: org.orgId, name: 'Scoped reader', email: 'scoped@scratch.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor }
    const hidden = randomUUID()
    await withBypassContext(() => db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${hidden},${org.orgId},${org.subsidiaryId},'Hidden entity','CAD','CA')`))
    const customerA = randomUUID()
    const customerB = randomUUID()
    const employee = randomUUID()
    await withBypassContext(() => db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom) values (${customerA},${org.orgId},'customer','Visible customer',${org.subsidiaryId},true,'{}'::jsonb),(${customerB},${org.orgId},'customer','Hidden customer',${hidden},true,'{}'::jsonb),(${employee},${org.orgId},'employee','Billable worker',${org.subsidiaryId},true,'{}'::jsonb)`))
    const projectA = randomUUID()
    const projectB = randomUUID()
    const projectCrossCustomer = randomUUID()
    await withBypassContext(() => db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active) values (${projectA},${org.orgId},${org.subsidiaryId},'VIS-JOB','Visible job',${customerA},'active',true),(${projectB},${org.orgId},${hidden},'HID-JOB','Hidden job',${customerB},'active',true),(${projectCrossCustomer},${org.orgId},${org.subsidiaryId},'XCU-JOB','Cross-customer job',${customerB},'active',true)`))
    await withBypassContext(() => db.execute(sql`insert into project_tasks (id, org_id, project_id, name) values (${randomUUID()}, ${org.orgId}, ${projectA}, 'Phase 1')`))
    await withBypassContext(() => db.execute(sql`insert into time_entries(id,org_id,employee_party_id,worked_on,hours,project_id,is_billable,status) values (${randomUUID()},${org.orgId},${employee},${org.date},8,${projectA},true,'approved')`))

    const seen = await get(org.orgId, projectA)
    assert.equal(seen.status, 200, JSON.stringify(await seen.clone().json()))
    const body = await seen.json() as { customerName: string | null; tasks: unknown[] }
    assert.equal(body.customerName, 'Visible customer')
    assert.equal(body.tasks.length, 1)

    const concealed = await get(org.orgId, projectB)
    assert.equal(concealed.status, 404)
    assert.deepEqual(await concealed.json(), { error: 'not found' })

    const cross = await get(org.orgId, projectCrossCustomer)
    assert.equal(cross.status, 200)
    assert.equal((await cross.json() as { customerName: string | null }).customerName, null)

    const ownTime = await getTime(org.orgId, projectA, employee)
    assert.equal(ownTime.status, 200, JSON.stringify(await ownTime.clone().json()))
    assert.equal((await ownTime.json() as { totals: { entries: number } }).totals.entries, 1)

    const foreignTime = await getTime(org.orgId, projectB, employee)
    assert.equal(foreignTime.status, 404)
  } finally {
    session.user = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

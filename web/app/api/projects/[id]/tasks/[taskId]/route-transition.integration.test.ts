import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { SessionUser } from '../../../../../../lib/auth'

const root = pathToFileURL(process.cwd() + '/').href
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __taskTransitionSession: session })
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" }
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__taskTransitionSession.user}' }
  if (specifier === '../../../../../../lib/projects-gate') return { shortCircuit: true, url: 'data:text/javascript,export async function guardProjectsFeature(){return null}' }
  if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
  return next(specifier, context)
}})

const { sql } = await import('drizzle-orm')
const { db, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { createWorkBreakdownTask, loadWorkBreakdownTasks } = await import('../../../../../../lib/project-work-breakdown')
const { PATCH } = await import('./route')

/**
 * Completed/cancelled WBS tasks used to reopen or change budget with no
 * transition rules and no reason — a finished task could silently come back
 * to life or re-price itself. Reopens and closed-task budget changes now
 * require a reason (evidenced in the audit row), and sideways moves between
 * terminal states refuse with the reopen-first remedy.
 */
test('closed WBS tasks reopen and re-budget only with a reason', async () => {
  const org = await createScratchOrg()
  try {
    const actor = await createScratchUser(org.orgId, 'Task owner', 'admin')
    await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`)
    await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,projects}', 'true'::jsonb, true) where id = ${org.orgId}`)
    session.user = { id: actor, orgId: org.orgId, name: 'Owner', email: 'owner@example.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor }
    const projectId = randomUUID()
    await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active,custom)
      values (${projectId},${org.orgId},${org.subsidiaryId},'WBS-T','Transition job',${org.customerId},'active',true,'{}'::jsonb)`)
    const input = { code: 'T-1', name: 'Footings', status: 'open' as const, estimatedHours: '10', estimatedCost: '100' }
    const created = await withOrgContext(org.orgId, () => createWorkBreakdownTask({
      orgId: org.orgId, projectId, actorId: actor, allowedSubsidiaryIds: null, input,
    }))
    const patch = (taskId: string, body: object) => withOrgContext(org.orgId, () => PATCH(
      new Request(`http://wbs.local/api/projects/${projectId}/tasks/${taskId}`, { method: 'PATCH', body: JSON.stringify(body) }),
      { params: Promise.resolve({ id: projectId, taskId }) },
    ))
    const version = async () => (await withOrgContext(org.orgId, () => loadWorkBreakdownTasks(org.orgId, projectId, null)))
      .find((task) => task.id === created.id)!.updatedAt
    const edit = (overrides: object, currentVersion: string) => ({
      code: 'T-1', name: 'Footings', status: 'open', estimatedHours: '10', estimatedCost: '100',
      ...overrides, expectedUpdatedAt: currentVersion,
    })

    // Open -> complete needs no reason.
    const completed = await patch(created.id, edit({ status: 'complete' }, await version()))
    assert.equal(completed.status, 200, await completed.clone().text())

    // Sideways complete -> cancelled refuses with the reopen-first remedy.
    const sideways = await patch(created.id, edit({ status: 'cancelled' }, await version()))
    assert.equal(sideways.status, 422, await sideways.clone().text())
    assert.match(await sideways.clone().text(), /Reopen the task before cancelling it/)

    // Reopen without a reason refuses; with a reason it saves and audits it.
    const silent = await patch(created.id, edit({ status: 'open' }, await version()))
    assert.equal(silent.status, 422, await silent.clone().text())
    assert.match(await silent.clone().text(), /Reopening a closed task requires a reason/)
    const reopened = await patch(created.id, edit({ status: 'open', reason: 'client reinstated the scope' }, await version()))
    assert.equal(reopened.status, 200, await reopened.clone().text())
    const reopenAudit = (await db.execute<{ changes: { reason?: string } }>(sql`
      select changes from audit_log
       where org_id = ${org.orgId} and table_name = 'project_tasks' and row_id = ${created.id} and action = 'update'
       order by id desc limit 1`)).rows[0]?.changes
    assert.equal(reopenAudit?.reason, 'client reinstated the scope')

    // Close again, then re-budget the closed task: reason required.
    const closed = await patch(created.id, edit({ status: 'complete' }, await version()))
    assert.equal(closed.status, 200, await closed.clone().text())
    const repriced = await patch(created.id, edit({ status: 'complete', estimatedHours: '20' }, await version()))
    assert.equal(repriced.status, 422, await repriced.clone().text())
    assert.match(await repriced.clone().text(), /Changing estimates on a closed task requires a reason/)
    const repricedReasoned = await patch(created.id, edit({ status: 'complete', estimatedHours: '20', reason: 're-estimated after delay' }, await version()))
    assert.equal(repricedReasoned.status, 200, await repricedReasoned.clone().text())

    // A rename-only save on the closed task still needs no reason.
    const renamed = await patch(created.id, edit({ status: 'complete', estimatedHours: '20', name: 'Footings rev 2' }, await version()))
    assert.equal(renamed.status, 200, await renamed.clone().text())
  } finally {
    session.user = null
    await dropScratchOrg(org.orgId)
  }
})

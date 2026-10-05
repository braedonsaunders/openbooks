import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import type { Authz } from './authz-core'
import { withAuthzContext } from './authz-context'
registerHooks({ resolve(specifier, context, next) {
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){throw new Error("Live identity resolver was called outside the verified frame.")}' }
  return next(specifier, context)
} })
const { getAuthz, can } = await import('./authz')
const principal = (id: string): Authz => ({ user: { orgId: id, id: 'operator' }, permissions: new Set(['reports.read']), allowedSubsidiaryIds: new Set([id]) }) as Authz
const delay = () => new Promise((resolve) => setTimeout(resolve, 5))

test('shared calculations keep the exact cached legal-entity and permission cohort during role changes', async () => {
  const verified = principal('entity-a')
  await withAuthzContext(verified, async () => {
    verified.allowedSubsidiaryIds!.add('entity-b'); verified.permissions.add('payroll.read')
    await delay()
    const current = await getAuthz()
    assert.deepEqual([...current!.allowedSubsidiaryIds!], ['entity-a'])
    assert.deepEqual([...current!.permissions], ['reports.read'])
  })
})

test('concurrent organizations have isolated authority frames and no authority remains after the request', async () => {
  await Promise.all(['company-a', 'company-b'].map((orgId) => withAuthzContext(principal(orgId), async () => {
    await delay()
    assert.equal((await getAuthz())!.user.orgId, orgId)
    assert.deepEqual([...(await getAuthz())!.allowedSubsidiaryIds!], [orgId])
  })))
  await assert.rejects(() => getAuthz(), /outside the verified frame/)
})

// Extension permission deactivation uses exact deny entries beneath wildcards.
test('authority snapshots retain exact runtime denies beneath wildcard grants', async () => {
  const verified = { ...principal('company-a'), permissions: new Set(['*', '!extension.private']) }
  await withAuthzContext(verified, async () => {
    const current = await getAuthz()
    assert.ok(current)
    assert.equal(can(current, 'reports.read'), true)
    assert.equal(can(current, 'extension.private'), false)
  })
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { SessionUser } from '../../../lib/auth'

const root = pathToFileURL(process.cwd() + '/').href
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __dunningScopeSession: session })
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__dunningScopeSession.user}' }
  if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
  return next(specifier, context)
}})
const { sql } = await import('drizzle-orm')
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { randomUUID } = await import('node:crypto')
const collection = await import('./route.ts')
const member = await import('./[id]/route.ts')

const DB = !!process.env.OPENBOOKS_DB_URL

// H-DUNNINGPOLICY: the dunning policy and its stages carry no subsidiary
// lineage yet apply to every entity's open items (and templates can hold
// entity-specific copy). Reads and writes alike need unrestricted scope:
// a restricted documents.manage holder gets one named 403 and writes
// nothing. Real route, real database, real role restriction.

const POLICY = {
  name: 'Standard ladder',
  stages: [{ sequence: 1, name: 'Reminder', offsetDays: 7, subjectTemplate: 'Pay up', bodyTemplate: 'Please pay' }],
}

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg())
  const owner = await withBypassContext(() => createScratchUser(org.orgId, 'Owner', 'dun_owner'))
  const scoped = await withBypassContext(() => createScratchUser(org.orgId, 'Scoped clerk', 'dun_scoped'))
  let secondSub = ''
  await withBypassContext(async () => {
    await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='dun_owner'`)
    const sub = await db.execute<{ id: string }>(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      select ${randomUUID()}, ${org.orgId}, s.id, 'Second Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb
        from subsidiaries s where s.org_id = ${org.orgId} and s.parent_id is null limit 1 returning id`)
    secondSub = sub.rows[0]!.id
    await db.execute(sql`
      update app_roles set permissions='["documents.manage"]'::jsonb,
        subsidiary_restriction=${JSON.stringify({ mode: 'list', subsidiaryIds: [secondSub] })}::jsonb
       where org_id=${org.orgId} and key='dun_scoped'`)
  })
  const user = (id: string, name: string, email: string): SessionUser => ({
    id, orgId: org.orgId, name, email, roles: [], isSuperAdmin: false, envKind: 'production',
    productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: id,
  })
  const ownerUser = user(owner, 'Owner', 'owner@scratch.test')
  const scopedUser = user(scoped, 'Scoped clerk', 'clerk@scratch.test')
  const get = () => withOrgContext(org.orgId, () => collection.GET())
  const post = (body: unknown) =>
    withOrgContext(org.orgId, () => collection.POST(new Request('http://audit.local/api/dunning', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }) as never))
  const patch = (id: string, body: unknown) =>
    withOrgContext(org.orgId, () => member.PATCH(new Request(`http://audit.local/api/dunning/${id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }) as never, { params: Promise.resolve({ id }) }))
  const remove = (id: string) =>
    withOrgContext(org.orgId, () => member.DELETE(new Request(`http://audit.local/api/dunning/${id}`, {
      method: 'DELETE',
    }) as never, { params: Promise.resolve({ id }) }))
  const policyCount = async (): Promise<number> =>
    Number((await db.execute<{ n: string }>(sql`select count(*) as n from dunning_policies where org_id=${org.orgId}`)).rows[0]!.n)
  const close = async () => {
    session.user = null
    await dropScratchOrg(org.orgId)
  }
  return { org, ownerUser, scopedUser, get, post, patch, remove, policyCount, close }
}

test('a subsidiary-restricted caller reads no dunning policy', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    session.user = f.ownerUser
    const created = await f.post(POLICY)
    assert.equal(created.status, 201)

    session.user = f.scopedUser
    const denied = await f.get()
    assert.equal(denied.status, 403)
    assert.deepEqual(await denied.json(), { error: 'requires unrestricted subsidiary access' })

    session.user = f.ownerUser
    const allowed = await f.get()
    assert.equal(allowed.status, 200)
    const body = (await allowed.json()) as { policies: { name: string }[] }
    assert.equal(body.policies.length, 1)
    assert.equal(body.policies[0]!.name, 'Standard ladder')
  } finally {
    await f.close()
  }
})

test('a subsidiary-restricted caller cannot create a dunning policy', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    session.user = f.scopedUser
    const before = await f.policyCount()
    const denied = await f.post({ ...POLICY, name: 'Rogue ladder' })
    assert.equal(denied.status, 403)
    assert.deepEqual(await denied.json(), { error: 'requires unrestricted subsidiary access' })
    assert.equal(await f.policyCount(), before, 'the refused write stored nothing')
  } finally {
    await f.close()
  }
})

test('a subsidiary-restricted caller cannot change or delete the policy', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    session.user = f.ownerUser
    const created = await f.post(POLICY)
    assert.equal(created.status, 201)
    const id = ((await created.json()) as { id: string }).id

    session.user = f.scopedUser
    const patchDenied = await f.patch(id, { name: 'Rewritten ladder' })
    assert.equal(patchDenied.status, 403)
    const deleteDenied = await f.remove(id)
    assert.equal(deleteDenied.status, 403)
    const name = (await db.execute<{ name: string }>(sql`select name from dunning_policies where id=${id}`)).rows[0]!.name
    assert.equal(name, 'Standard ladder', 'the refused writes changed nothing')
    assert.equal(await f.policyCount(), 1)

    session.user = f.ownerUser
    const renamed = await f.patch(id, { name: 'Renamed ladder' })
    assert.equal(renamed.status, 200)
    const removed = await f.remove(id)
    assert.equal(removed.status, 200)
    assert.equal(await f.policyCount(), 0)
  } finally {
    await f.close()
  }
})

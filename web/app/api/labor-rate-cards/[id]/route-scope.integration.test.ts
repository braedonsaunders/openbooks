import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { sql } from 'drizzle-orm'
import type { SessionUser } from '../../../../lib/auth'

const root = pathToFileURL(process.cwd() + '/').href
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __lrcScopeSession: session })
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__lrcScopeSession.user}' }
  if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
  return next(specifier, context)
}})
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg, seedFlowActors } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { PUT } = await import('./route.ts')

const DB = !!process.env.OPENBOOKS_DB_URL

// H-LABORRATE: a subsidiary-restricted setup manager must not set or alter
// another entity's labour pricing by naming its subsidiary, project, or
// customer, nor rewrite a version already in use by that entity. Unknown,
// cross-org, and out-of-scope ids share one "target" refusal; a stored
// out-of-scope touch answers like a missing version. Real route, real
// database, real role restriction.

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Field Crew Rates',
    code: 'FIELD',
    effective_from: '2026-07-01',
    status: 'draft',
    derivation_policy: 'explicit',
    scopes: [],
    lines: [],
    adjustments: [],
    terms: [],
    ...overrides,
  }
}

function adjustment(targets: Record<string, unknown>[]): Record<string, unknown> {
  return {
    code: 'scope-probe',
    name: 'Scope probe',
    category: 'markup',
    calculation: 'fixed',
    value: '10',
    presentation: 'separate',
    targets,
  }
}

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg())
  const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId
  const owner = await withBypassContext(() => createScratchUser(org.orgId, 'Owner', 'lrc_owner'))
  const scoped = await withBypassContext(() => createScratchUser(org.orgId, 'A clerk', 'lrc_scoped'))
  const ids = {
    subB: '', projectA: '', projectB: '', projectNull: '',
    customerA: '', customerB: '', book: randomUUID(), version: randomUUID(),
  }
  await withBypassContext(async () => {
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',
      coalesce(settings->'features','{}'::jsonb)||'{"projects":true,"multiCurrency":true,"inventory":true}'::jsonb)
      where id=${org.orgId}`)
    await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='lrc_owner'`)
    const sub = await db.execute<{ id: string }>(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      select ${randomUUID()}, ${org.orgId}, s.id, 'Entity B', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb
        from subsidiaries s where s.org_id = ${org.orgId} and s.parent_id is null limit 1 returning id`)
    ids.subB = sub.rows[0]!.id
    await db.execute(sql`
      update app_roles set permissions='["admin.setup.manage"]'::jsonb,
        subsidiary_restriction=${JSON.stringify({ mode: 'list', subsidiaryIds: [org.subsidiaryId] })}::jsonb
       where org_id=${org.orgId} and key='lrc_scoped'`)
    for (const [key, subId] of [['projectA', org.subsidiaryId], ['projectB', ids.subB]] as const) {
      const pid = randomUUID()
      ids[key] = pid
      await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active)
        values (${pid},${org.orgId},${subId},${key},${key},${org.customerId},'active',true)`)
    }
    const nullPid = randomUUID()
    ids.projectNull = nullPid
    await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active)
      values (${nullPid},${org.orgId},null,'projectNull','Unattributed job',${org.customerId},'active',true)`)
    for (const [key, subId] of [['customerA', org.subsidiaryId], ['customerB', ids.subB]] as const) {
      const partyId = randomUUID()
      ids[key] = partyId
      await db.execute(sql`insert into parties(org_id,id,kind,display_name,subsidiary_id,is_active,custom)
        values (${org.orgId},${partyId},'customer',${key},${subId},true,'{}'::jsonb)`)
      await db.execute(sql`insert into customer_roles(org_id,party_id,is_active) values (${org.orgId},${partyId},true)`)
    }
    await db.execute(sql`insert into item_rate_books(org_id,id,code,name,currency,is_default,is_active,created_by,updated_by)
      values (${org.orgId},${ids.book},'FIELD','Field Rates','CAD',false,true,${actorId},${actorId})`)
    await db.execute(sql`insert into item_rate_versions(org_id,id,rate_book_id,effective_from,status,custom,created_by,updated_by)
      values (${org.orgId},${ids.version},${ids.book},'2026-07-01','draft','{}'::jsonb,${actorId},${actorId})`)
    await db.execute(sql`insert into labor_rate_version_policies(org_id,version_id,derivation_policy,created_by,updated_by)
      values (${org.orgId},${ids.version},'explicit',${actorId},${actorId})`)
  })
  const user = (id: string, name: string, email: string): SessionUser => ({
    id, orgId: org.orgId, name, email, roles: [], isSuperAdmin: false, envKind: 'production',
    productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: id,
  })
  const put = (payload: Record<string, unknown>) =>
    withOrgContext(org.orgId, () => PUT(new Request(`http://audit.local/api/labor-rate-cards/${ids.version}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    }), { params: Promise.resolve({ id: ids.version }) }))
  const scopeCount = async (): Promise<number> =>
    Number((await db.execute<{ n: string }>(sql`select count(*) as n from labor_rate_version_scopes where version_id=${ids.version}`)).rows[0]!.n)
  const close = async () => {
    session.user = null
    await dropScratchOrg(org.orgId)
  }
  return { org, ids, ownerUser: user(owner, 'Owner', 'owner@scratch.test'), scopedUser: user(scoped, 'A clerk', 'clerk@scratch.test'), put, scopeCount, close }
}

test('a restricted manager cannot scope or target another entity’s pricing', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    session.user = f.scopedUser
    for (const [label, payload] of [
      ['subsidiary scope', body({ scopes: [{ scopeType: 'subsidiary', scopeValueId: f.ids.subB }] })],
      ['subsidiary target', body({ adjustments: [adjustment([{ targetType: 'subsidiary', targetValueId: f.ids.subB }])] })],
      ['project target', body({ adjustments: [adjustment([{ targetType: 'project', targetValueId: f.ids.projectB }])] })],
      ['customer target', body({ adjustments: [adjustment([{ targetType: 'customer', targetValueId: f.ids.customerB }])] })],
      ['null-subsidiary project target', body({ adjustments: [adjustment([{ targetType: 'project', targetValueId: f.ids.projectNull }])] })],
    ] as const) {
      const res = await f.put(payload)
      assert.equal(res.status, 422, label)
      assert.deepEqual(await res.json(), { errorCode: 'target' }, label)
    }
    assert.equal(await f.scopeCount(), 0, 'no refused save stored anything')
  } finally {
    await f.close()
  }
})

test('a version already pricing another entity is not-found to a restricted manager', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    session.user = f.ownerUser
    const seeded = await f.put(body({ scopes: [{ scopeType: 'subsidiary', scopeValueId: f.ids.subB }] }))
    assert.equal(seeded.status, 200)
    assert.equal(await f.scopeCount(), 1)

    session.user = f.scopedUser
    const denied = await f.put(body())
    assert.equal(denied.status, 404)
    assert.deepEqual(await denied.json(), { errorCode: 'notFound' })
    assert.equal(await f.scopeCount(), 1, 'the refused rewrite kept the stored scope')

    session.user = f.ownerUser
    const allowed = await f.put(body())
    assert.equal(allowed.status, 200)
    assert.equal(await f.scopeCount(), 0, 'unrestricted saves still replace scopes')
  } finally {
    await f.close()
  }
})

test('in-scope subsidiary, project, and customer references still save', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    session.user = f.scopedUser
    const res = await f.put(body({
      scopes: [{ scopeType: 'subsidiary', scopeValueId: f.org.subsidiaryId }],
      adjustments: [adjustment([
        { targetType: 'project', targetValueId: f.ids.projectA },
        { targetType: 'customer', targetValueId: f.ids.customerA },
      ])],
    }))
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()).slice(0, 300))
    assert.equal(await f.scopeCount(), 1)
  } finally {
    await f.close()
  }
})

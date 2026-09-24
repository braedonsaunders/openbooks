import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import type { SessionUser } from '../../../lib/auth'

// H-AGENTSCOPE: an assistant.use holder restricted to one subsidiary must
// see only that entity's account-subject findings — never B's subjects,
// names, summaries, materiality, or evidence — and must not move B's
// findings through the item, lifecycle, feedback, or report endpoints.
// Record-level denials answer exactly like not-found; the narrative PDF
// (unfilterable free text) needs unrestricted scope. Real routes, real
// database, real role restriction; only the session identity is scripted.
const root = pathToFileURL(process.cwd() + '/').href
const state: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __agentScopeSession: state })
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" }
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__agentScopeSession.user}' }
  if (specifier.startsWith('@/')) {
    const path = root + 'web/' + specifier.slice(2)
    for (const suffix of ['.ts', '.tsx', '/index.ts', '/index.tsx']) if (existsSync(new URL(path + suffix))) return next(path + suffix, context)
    return next(path, context)
  }
  return next(specifier, context)
}})
const { sql } = await import('drizzle-orm')
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { GET: getInbox } = await import('./inbox/route.ts')
const { GET: getItem, PATCH: patchItem } = await import('../continuous-close/items/[id]/route.ts')
const { PUT: putFeedback } = await import('../continuous-close/items/[id]/feedback/route.ts')
const { GET: getReportPdf } = await import('../continuous-close/reports/[runId]/pdf/route.ts')

const DB = !!process.env.OPENBOOKS_DB_URL
const SCOPED_PERMS = ['assistant.use', 'assistant.write', 'gl.read']

async function seedFinding(orgId: string, subjectType: string | null, subjectId: string | null): Promise<string> {
  const id = randomUUID()
  await withBypassContext(() => db.execute(sql`insert into ai_work_items
    (id, org_id, agent_key, finding_type, detector_version, fingerprint, severity, confidence, materiality,
     subject_type, subject_id, summary)
    values (${id}, ${orgId}, 'accounting', 'stale_unreconciled_item', 'test', ${`fp-${id}`},
      'warning', '0.8', '2500', ${subjectType}, ${subjectId}, '{"headline":"scope probe"}'::jsonb)`))
  return id
}

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg())
  const owner = await withBypassContext(() => createScratchUser(org.orgId, 'Owner', 'scope_owner'))
  const scoped = await withBypassContext(() => createScratchUser(org.orgId, 'A clerk', 'scope_clerk'))
  const accts = (await withBypassContext(() => db.execute<{ id: string }>(sql`
    select id from accounts where org_id=${org.orgId} and is_active order by number limit 3`))).rows.map((r) => r.id)
  assert.equal(accts.length, 3)
  const [acctA, acctB, acctN] = accts as [string, string, string]
  let subB = ''
  await withBypassContext(async () => {
    await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='scope_owner'`)
    const sub = await db.execute<{ id: string }>(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      select ${randomUUID()}, ${org.orgId}, s.id, 'Entity B', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb
        from subsidiaries s where s.org_id = ${org.orgId} and s.parent_id is null limit 1 returning id`)
    subB = sub.rows[0]!.id
    await db.execute(sql`
      update app_roles set permissions=${JSON.stringify(SCOPED_PERMS)}::jsonb,
        subsidiary_restriction=${JSON.stringify({ mode: 'list', subsidiaryIds: [org.subsidiaryId] })}::jsonb
       where org_id=${org.orgId} and key='scope_clerk'`)
    await db.execute(sql`update accounts set subsidiary_id=${org.subsidiaryId} where id=${acctA}`)
    await db.execute(sql`update accounts set subsidiary_id=${subB} where id=${acctB}`)
    await db.execute(sql`update accounts set subsidiary_id=null where id=${acctN}`)
  })
  const itemA = await seedFinding(org.orgId, 'account', acctA)
  const itemB = await seedFinding(org.orgId, 'account', acctB)
  const itemN = await seedFinding(org.orgId, 'account', acctN)
  const itemX = await seedFinding(org.orgId, 'vendor', randomUUID())
  const user = (id: string, name: string): SessionUser => ({
    id, orgId: org.orgId, name, email: `${name}@scratch.test`, roles: [], isSuperAdmin: false,
    envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: id,
  })
  const asOwner = () => { state.user = user(owner, 'owner') }
  const asScoped = () => { state.user = user(scoped, 'clerk') }
  const itemParams = (id: string) => ({ params: Promise.resolve({ id }) })
  const close = async () => {
    state.user = null
    await dropScratchOrg(org.orgId)
  }
  return { org, itemA, itemB, itemN, itemX, asOwner, asScoped, itemParams, close }
}

test('a restricted caller lists only their entity’s findings', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    await withOrgContext(f.org.orgId, async () => {
      f.asScoped()
      const scoped = await (await getInbox(new Request('https://x/api/agents/inbox'))).json() as { ok: boolean; total: number; rows: { id: string }[] }
      assert.equal(scoped.ok, true)
      assert.deepEqual(scoped.rows.map((i) => i.id), [f.itemA])
      assert.equal(scoped.total, 1)
      f.asOwner()
      const full = await (await getInbox(new Request('https://x/api/agents/inbox'))).json() as { ok: boolean; total: number }
      assert.equal(full.ok, true)
      assert.equal(full.total, 4)
    })
  } finally {
    await f.close()
  }
})

test('a restricted caller reads only their entity’s finding detail', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    await withOrgContext(f.org.orgId, async () => {
      f.asScoped()
      const hit = await (await getItem(new Request('https://x/'), f.itemParams(f.itemA))).json() as { item: { id: string } }
      assert.equal(hit.item.id, f.itemA)
      for (const [label, id] of [['other entity', f.itemB], ['unattributed', f.itemN], ['unresolved subject', f.itemX]] as const) {
        const res = await getItem(new Request('https://x/'), f.itemParams(id))
        assert.equal(res.status, 404, label)
      }
    })
  } finally {
    await f.close()
  }
})

test('a restricted caller cannot move another entity’s finding lifecycle', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    await withOrgContext(f.org.orgId, async () => {
      f.asScoped()
      const denied = await patchItem(new Request('https://x/', {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'review' }),
      }), f.itemParams(f.itemB))
      assert.equal(denied.status, 404)
      const statusB = (await db.execute<{ status: string }>(sql`select status from ai_work_items where id=${f.itemB}`)).rows[0]!.status
      assert.equal(statusB, 'open', 'the refused transition wrote nothing')
      const allowed = await patchItem(new Request('https://x/', {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'review' }),
      }), f.itemParams(f.itemA))
      assert.equal(allowed.status, 200)
      const statusA = (await db.execute<{ status: string }>(sql`select status from ai_work_items where id=${f.itemA}`)).rows[0]!.status
      assert.equal(statusA, 'in_review')
    })
  } finally {
    await f.close()
  }
})

test('a restricted caller cannot rate another entity’s finding', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    await withOrgContext(f.org.orgId, async () => {
      f.asScoped()
      const denied = await putFeedback(new Request('https://x/', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rating: 'helpful', comment: 'noted' }),
      }), f.itemParams(f.itemB))
      assert.equal(denied.status, 404)
      const count = Number((await db.execute<{ n: string }>(sql`select count(*) as n from ai_work_item_feedback where work_item_id=${f.itemB}`)).rows[0]!.n)
      assert.equal(count, 0, 'no feedback row persists from the refused write')
    })
  } finally {
    await f.close()
  }
})

test('the narrative PDF needs unrestricted scope', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    await withOrgContext(f.org.orgId, async () => {
      f.asScoped()
      const denied = await getReportPdf(new Request('https://x/'), { params: Promise.resolve({ runId: randomUUID() }) })
      assert.equal(denied.status, 403)
      assert.deepEqual(await denied.json(), { error: 'requires unrestricted subsidiary access' })
      f.asOwner()
      // No run seeded: the unrestricted caller passes the scope gate and
      // reaches the missing-report shape.
      const passed = await getReportPdf(new Request('https://x/'), { params: Promise.resolve({ runId: randomUUID() }) })
      assert.equal(passed.status, 404)
    })
  } finally {
    await f.close()
  }
})

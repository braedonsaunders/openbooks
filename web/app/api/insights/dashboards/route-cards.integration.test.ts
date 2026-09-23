import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { SessionUser } from '../../../../lib/auth'

// Dashboard create must validate layout cards exactly like PATCH: a layout
// naming a missing card or a card from another org is a 422 that commits
// nothing — no dashboard row and no audit event. (The embed loader silently
// drops such cards, so without this check a client would get a 201 plus an
// audited layout and then an empty dashboard.)
const root = pathToFileURL(process.cwd() + '/').href
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __insightDashboardCardsSession: session })
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__insightDashboardCardsSession.user}' }
  if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
  return next(specifier, context)
}})

const { sql } = await import('drizzle-orm')
const { db, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { POST } = await import('./route')

function signIn(orgId: string, actor: string): void {
  session.user = { id: actor, orgId, name: 'Dashboard cards', email: 'dashboard-cards@scratch.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: orgId, homeOrgId: orgId, homeUserId: actor }
}

async function insertCard(orgId: string, actor: string, status = 'published'): Promise<string> {
  const id = randomUUID()
  await db.execute(sql`insert into insight_cards (id, org_id, name, status, created_by, updated_by)
    values (${id}, ${orgId}, ${'Card ' + id.slice(0, 8)}, ${status}, ${actor}, ${actor})`)
  return id
}

function createRequest(key: string, body: unknown): Request {
  return new Request('http://cards.local/api/insights/dashboards', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify(body),
  })
}

const layoutFor = (cardId: string) => [{ cardId, x: 0, y: 0, w: 6, h: 4 }]

test('dashboard create refuses missing and foreign cards without committing anything', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  const other = await createScratchOrg()
  try {
    const actor = await createScratchUser(org.orgId, 'Dashboard cards', 'reviewer')
    await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`)
    const otherActor = await createScratchUser(other.orgId, 'Dashboard cards', 'reviewer')
    await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${other.orgId} and key='reviewer'`)
    const ownCard = await insertCard(org.orgId, actor)
    const foreignCard = await insertCard(other.orgId, otherActor)
    signIn(org.orgId, actor)

    await withOrgContext(org.orgId, async () => {
      // A layout naming a card from another org is refused…
      const foreign = await POST(createRequest(randomUUID(), { name: 'Foreign board', layout: layoutFor(foreignCard) }))
      assert.equal(foreign.status, 422, await foreign.clone().text())
      assert.deepEqual(await foreign.json(), { error: 'Layout references an unavailable card' })

      // …as is a layout naming a card that does not exist…
      const missing = await POST(createRequest(randomUUID(), { name: 'Missing board', layout: layoutFor(randomUUID()) }))
      assert.equal(missing.status, 422, await missing.clone().text())

      // …and neither refusal leaves a row or an audit event behind.
      const leftovers = (await db.execute<{ count: string }>(sql`select count(*) from insight_dashboards where org_id = ${org.orgId}`)).rows[0]
      assert.equal(leftovers?.count, '0', 'refused creates commit no dashboard row')
      const audits = (await db.execute<{ count: string }>(sql`select count(*) from audit_log where org_id = ${org.orgId} and table_name = 'insight_dashboards'`)).rows[0]
      assert.equal(audits?.count, '0', 'refused creates commit no audit event')

      // A layout naming a visible same-org card still creates.
      const created = await POST(createRequest(randomUUID(), { name: 'Own board', layout: layoutFor(ownCard) }))
      assert.equal(created.status, 201, await created.clone().text())
    })
  } finally {
    session.user = null
    await dropScratchOrg(org.orgId)
    await dropScratchOrg(other.orgId)
  }
})

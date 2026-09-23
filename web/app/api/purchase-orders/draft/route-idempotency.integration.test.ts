import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import type { SessionUser } from '../../../../lib/auth'

// Instant-into-draft is idempotent through the one shared draft factory
// (createOrderDraft): the caller's Idempotency-Key header becomes the
// document id, so a lost-response retry replays the same order instead of
// minting a second one and burning a second number. All three draft routes
// enforce the same contract — no route mints without a key.
const root = pathToFileURL(process.cwd() + '/').href
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __poDraftIdempotencySession: session })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) {
      return virtual(`export async function currentUser(){return globalThis.__poDraftIdempotencySession.user}`)
    }
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { POST: postPurchase } = await import('./route')
const { POST: postSales } = await import('../../sales-orders/draft/route')
const { POST: postEstimate } = await import('../../estimates/draft/route')
const DB = !!process.env.OPENBOOKS_DB_URL

type Post = (req: Request) => Promise<Response>

async function setup() {
  const org = await withBypassContext(() => createScratchOrg())
  const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Order drafter', 'reviewer'))
  await withBypassContext(() => db.execute(sql`
    update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`))
  await withBypassContext(() => db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{features}',
      coalesce(settings->'features', '{}'::jsonb) || '{"orders":true}'::jsonb)
    where id = ${org.orgId}`))
  session.user = {
    id: actor, orgId: org.orgId, name: 'Order drafter', email: 'drafter@scratch.test',
    roles: [], isSuperAdmin: false, envKind: 'production' as const,
    productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor,
  }
  return { org, actor }
}

function postDraft(post: Post, path: string, key: string | null) {
  return withOrgContext(session.user!.orgId, () =>
    post(
      new Request(`http://orders.test${path}`, {
        method: 'POST',
        headers: key ? { 'Idempotency-Key': key } : {},
      }),
    ),
  )
}

async function kindCount(orgId: string, kind: string): Promise<number> {
  const r = await withBypassContext(() => db.execute<{ n: string }>(sql`
    select count(*)::text as n from documents
     where org_id = ${orgId} and kind = ${kind}`))
  return Number(r.rows[0]?.n ?? 0)
}

for (const [kind, path, post, prefix] of [
  ['purchase_order', '/api/purchase-orders/draft', postPurchase, 'PO-'],
  ['sales_order', '/api/sales-orders/draft', postSales, 'SO-'],
  ['quote', '/api/estimates/draft', postEstimate, 'EST-'],
] as const) {
  test(`${kind} draft requires an Idempotency-Key`, { skip: !DB }, async () => {
    const { org } = await setup()
    try {
      assert.equal((await postDraft(post, path, null)).status, 400)
      assert.equal((await postDraft(post, path, 'not-a-uuid')).status, 400)
      assert.equal(await kindCount(org.orgId, kind), 0)
    } finally {
      session.user = null
      await dropScratchOrg(org.orgId)
    }
  })

  test(`a retried ${kind} draft replays instead of minting a second numbered document`, { skip: !DB }, async () => {
    const { org } = await setup()
    try {
      const key = randomUUID()
      const first = await postDraft(post, path, key)
      assert.equal(first.status, 201)
      const firstBody = (await first.json()) as { id: string; document_number: string }
      assert.equal(firstBody.id, key)
      assert.match(firstBody.document_number, new RegExp(`^${prefix}`))
      const retry = await postDraft(post, path, key)
      assert.equal(retry.status, 200)
      assert.deepEqual((await retry.json()) as unknown, firstBody)
      assert.equal(await kindCount(org.orgId, kind), 1)
    } finally {
      session.user = null
      await dropScratchOrg(org.orgId)
    }
  })
}

test('a purchase-order draft key minted for another document refuses as conflict', { skip: !DB }, async () => {
  const { org } = await setup()
  try {
    // A row this endpoint did not create owns the key and carries no
    // idempotent-create audit image: replay must refuse, never return it.
    const key = randomUUID()
    await withBypassContext(() => db.execute(sql`
      insert into documents (id, org_id, kind, document_number, document_date, currency, subsidiary_id, subtotal, tax_total, total)
      values (${key}, ${org.orgId}, 'sales_order', ${'SO-' + key.slice(0, 8)}, ${org.date}, 'CAD', ${org.subsidiaryId}, '0', '0', '0')`))
    const response = await postDraft(postPurchase, '/api/purchase-orders/draft', key)
    assert.equal(response.status, 409)
    assert.equal(await kindCount(org.orgId, 'purchase_order'), 0)
  } finally {
    session.user = null
    await dropScratchOrg(org.orgId)
  }
})

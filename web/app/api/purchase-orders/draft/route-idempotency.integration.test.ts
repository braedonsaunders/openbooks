import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import type { SessionUser } from '../../../../lib/auth'

// Instant-into-draft is idempotent under the canonical order-create
// contract: the caller's Idempotency-Key header becomes the document id, so
// a lost-response retry replays the same purchase order instead of minting
// a second one and burning a second PO number.
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
const { POST } = await import('./route')
const DB = !!process.env.OPENBOOKS_DB_URL

async function setup() {
  const org = await withBypassContext(() => createScratchOrg())
  const actor = await withBypassContext(() => createScratchUser(org.orgId, 'PO drafter', 'reviewer'))
  await withBypassContext(() => db.execute(sql`
    update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`))
  await withBypassContext(() => db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{features}',
      coalesce(settings->'features', '{}'::jsonb) || '{"orders":true}'::jsonb)
    where id = ${org.orgId}`))
  session.user = {
    id: actor, orgId: org.orgId, name: 'PO drafter', email: 'drafter@scratch.test',
    roles: [], isSuperAdmin: false, envKind: 'production' as const,
    productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor,
  }
  return { org, actor }
}

function postDraft(key: string | null) {
  return withOrgContext(session.user!.orgId, () =>
    POST(
      new Request('http://orders.test/api/purchase-orders/draft', {
        method: 'POST',
        headers: key ? { 'Idempotency-Key': key } : {},
      }),
    ),
  )
}

async function poCount(orgId: string): Promise<number> {
  const r = await withBypassContext(() => db.execute<{ n: string }>(sql`
    select count(*)::text as n from documents
     where org_id = ${orgId} and kind = 'purchase_order'`))
  return Number(r.rows[0]?.n ?? 0)
}

test('purchase-order draft requires an Idempotency-Key', { skip: !DB }, async () => {
  const { org } = await setup()
  try {
    const missing = await postDraft(null)
    assert.equal(missing.status, 400)
    const malformed = await postDraft('not-a-uuid')
    assert.equal(malformed.status, 400)
    assert.equal(await poCount(org.orgId), 0)
  } finally {
    session.user = null
    await dropScratchOrg(org.orgId)
  }
})

test('a retried purchase-order draft replays instead of minting a second PO', { skip: !DB }, async () => {
  const { org } = await setup()
  try {
    const key = randomUUID()
    const first = await postDraft(key)
    assert.equal(first.status, 201)
    const firstBody = (await first.json()) as { id: string; document_number: string }
    assert.equal(firstBody.id, key)
    assert.match(firstBody.document_number, /^PO-/)
    const retry = await postDraft(key)
    assert.equal(retry.status, 200)
    const retryBody = (await retry.json()) as { id: string; document_number: string }
    assert.deepEqual(retryBody, firstBody)
    assert.equal(await poCount(org.orgId), 1)
  } finally {
    session.user = null
    await dropScratchOrg(org.orgId)
  }
})

test('a purchase-order draft key minted for another document refuses as conflict', { skip: !DB }, async () => {
  const { org } = await setup()
  try {
    // A row this endpoint did not create owns the key and carries no
    // idempotent-create audit image: replay must refuse, never return it.
    const key = randomUUID()
    await withBypassContext(() => db.execute(sql`
      insert into documents (id, org_id, kind, document_number, document_date, currency, subsidiary_id, subtotal, tax_total, total)
      values (${key}, ${org.orgId}, 'sales_order', ${'SO-' + key.slice(0, 8)}, ${org.date}, 'CAD', ${org.subsidiaryId}, '0', '0', '0')`))
    const response = await postDraft(key)
    assert.equal(response.status, 409)
    assert.equal(await poCount(org.orgId), 0)
  } finally {
    session.user = null
    await dropScratchOrg(org.orgId)
  }
})

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Only the session is stubbed: the real authz module (and its real
// guardSubsidiaryScope) is re-exported, so the scope refusal is exercised.
const state: { authz: unknown } = { authz: null }
Object.assign(globalThis, { __backorderRouteState: state })
const realAuthz = new URL('../../../../../lib/authz.ts', import.meta.url).href
const authzStub = {
  shortCircuit: true as const,
  url: 'data:text/javascript,' + encodeURIComponent(`
    export * from '${realAuthz}';
    export async function getAuthz() { return globalThis.__backorderRouteState.authz }
    export async function guardPermission() { return globalThis.__backorderRouteState.authz }
  `),
}
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@/lib/authz' || (specifier === './authz' && context.parentURL?.includes('/web/lib/feature-gates'))) return authzStub
    return next(specifier, context)
  },
})
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { GET, POST } = await import('./route.ts')

test('backorders route: feature fence, position, cancel refusal and out-of-scope 404', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  const orderId = randomUUID()
  const lineId = randomUUID()
  try {
    await withBypassContext(async () => {
      await db.execute(sql`
        insert into documents (id, org_id, kind, document_number, document_date, status, currency, subtotal, tax_total, total, subsidiary_id, party_id)
        values (${orderId}, ${org.orgId}, 'sales_order', 'SO-ROUTE', ${org.date}, 'draft', 'CAD', '0', '0', '0', ${org.subsidiaryId}, ${org.customerId})`)
      await db.execute(sql`
        insert into document_lines (id, org_id, document_id, line_number, item_id, quantity, unit_price, amount, stock_location_id)
        values (${lineId}, ${org.orgId}, ${orderId}, 1, ${org.items.fifo}, '5', '1', '5', ${org.stockLocationId})`)
      await db.execute(sql`update documents set status = 'approved' where id = ${orderId} and org_id = ${org.orgId}`)
    })
    const actor = (allowedSubsidiaryIds: Set<string> | null) => ({
      user: { id: randomUUID(), orgId: org.orgId, roles: [] }, permissions: new Set(['orders.fulfill']), allowedSubsidiaryIds,
    })
    const call = async (method: 'GET' | 'POST', body?: unknown) => {
      const request = new Request(`http://orders.test/api/sales-orders/${orderId}/backorders`, {
        method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
      })
      const handler = method === 'GET' ? GET : POST
      const response = await withOrgContext(org.orgId, () => handler(request, { params: Promise.resolve({ id: orderId }) }))
      return { status: response.status, json: (await response.json().catch(() => null)) as Record<string, unknown> }
    }

    state.authz = actor(null)
    assert.deepEqual(await call('GET'), { status: 404, json: { error: 'not_found' } }, 'Fulfillment off answers 404 naming nothing')

    await withBypassContext(() => db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb)
             || '{"orders":true,"warehousing":true,"fulfillment":true}'::jsonb) where id = ${org.orgId}`))
    const position = await call('GET')
    assert.equal(position.status, 200)
    assert.deepEqual((position.json.lines as { lineId: string }[]).map((line) => line.lineId), [lineId])

    const refused = await call('POST', { lineId, quantity: '6', reason: 'customer reduced the order' })
    assert.equal(refused.status, 422)
    assert.equal(refused.json.code, 'exceeds_open_quantity')
    assert.match(String(refused.json.error), /SO-ROUTE line 1 has 5 open; cannot cancel 6/)
    assert.equal(refused.json.remedy, 'Cancel at most 5')
    const done = await call('POST', { lineId, quantity: '2', reason: 'customer reduced the order' })
    assert.equal(done.status, 200, JSON.stringify(done.json))
    assert.equal(done.json.open, '3.00000000')

    state.authz = actor(new Set([randomUUID()]))
    // Out of scope is indistinguishable from an absent order.
    assert.deepEqual(await call('GET'), { status: 404, json: { error: 'not_found' } })
    assert.deepEqual(await call('POST', { lineId, quantity: '1', reason: 'out of scope' }), { status: 404, json: { error: 'not_found' } })
  } finally {
    state.authz = null
    await dropScratchOrg(org.orgId)
  }
})

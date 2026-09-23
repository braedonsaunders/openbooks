import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { sql } from 'drizzle-orm'

const stateKey = Symbol.for('openbooks.item-rates-precision-route-test')
const routeState: { gate: { user: { orgId: string; id: string } } | null } = { gate: null }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState

const webRoot = `${pathToFileURL(`${process.cwd()}/web/`).href}`
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    if (specifier.endsWith('/lib/feature-gates')) return { shortCircuit: true, url: 'mock:item-rates-precision-gates' }
    if (specifier.endsWith('/lib/features')) return { shortCircuit: true, url: 'mock:item-rates-precision-features' }
    if (specifier.startsWith('@/')) return nextResolve(`${webRoot}${specifier.slice(2)}.ts`, context)
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:item-rates-precision-gates') {
      return {
        shortCircuit: true,
        format: 'module',
        source: `export async function guardFeaturePermission() { return globalThis[Symbol.for('openbooks.item-rates-precision-route-test')].gate }`,
      }
    }
    if (url === 'mock:item-rates-precision-features') {
      return { shortCircuit: true, format: 'module', source: 'export async function isFeatureEnabled() { return true }' }
    }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?item-rates-precision-route-integration'
const { POST } = (await import(routeUrl)) as typeof import('./route')

const { db } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
hooks.deregister()

const DB = Boolean(process.env.OPENBOOKS_DB_URL)

function post(itemId: string, body: Record<string, unknown>) {
  return POST(new Request(`http://openbooks.test/api/items/${itemId}/rates`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: itemId }) })
}

function versioned(itemId: string, book: string, quantity: string, from: string) {
  return {
    rateBookId: book, effectiveFrom: from, baseUnit: 'hour',
    pricingPolicy: 'capped_ladder', invoicePresentation: 'rate_components',
    tiers: [{ unitCode: 'hour', unitName: 'Hour', baseQuantity: quantity, costRate: '100', billRate: '100' }],
  }
}

/**
 * PRC6: base quantities persist as numeric(19,4). "1.00005" must be refused
 * by name instead of rounding silently to 1.0001 in PostgreSQL, and the
 * refusal must leave the prior version intact.
 */
test('a five-decimal base quantity is refused and the prior version stands', { skip: !DB }, async () => {
  const org = await createScratchOrg()
  try {
    routeState.gate = { user: { orgId: org.orgId, id: org.orgId } }
    const book = randomUUID()
    await db.execute(sql`insert into item_rate_books (id, org_id, code, name, currency, is_default, is_active)
      values (${book}, ${org.orgId}, 'PRECISION', 'Precision book', 'CAD', false, true)`)

    const first = await post(org.items.service, versioned(org.items.service, book, '1', '2026-01-01'))
    assert.equal(first.status, 200, await first.text())

    const precise = await post(org.items.service, versioned(org.items.service, book, '1.00005', '2026-02-01'))
    assert.equal(precise.status, 422)
    assert.match(String((await precise.json()).error), /at most 4 decimal places/)

    const versions = (await db.execute<{ effective_from: string }>(sql`
      select effective_from::text from item_rate_versions
       where org_id = ${org.orgId} and rate_book_id = ${book} and status = 'active'
       order by effective_from`)).rows
    assert.deepEqual(versions.map((v) => String(v.effective_from).slice(0, 10)), ['2026-01-01'])
    const stored = (await db.execute<{ base_quantity: string }>(sql`
      select base_quantity::text from item_rate_lines
       where org_id = ${org.orgId} and item_id = ${org.items.service}`)).rows
    assert.deepEqual(stored.map((r) => r.base_quantity), ['1.0000'])

    const valid = await post(org.items.service, versioned(org.items.service, book, '1.0001', '2026-02-01'))
    assert.equal(valid.status, 200, await valid.text())
  } finally {
    routeState.gate = null
    await dropScratchOrg(org.orgId)
  }
})

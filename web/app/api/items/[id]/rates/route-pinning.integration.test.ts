import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { sql } from 'drizzle-orm'

const webRoot = `${pathToFileURL(`${process.cwd()}/web/`).href}`

const stateKey = Symbol.for('openbooks.item-rates-pin-route-test')
const routeState: { gate: { user: { orgId: string; id: string } } | null } = { gate: null }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    if (specifier.endsWith('/lib/feature-gates')) return { shortCircuit: true, url: 'mock:item-rates-feature-gates' }
    if (specifier.endsWith('/lib/features')) return { shortCircuit: true, url: 'mock:item-rates-features' }
    if (specifier.startsWith('@/')) {
      return nextResolve(`${webRoot}${specifier.slice(2)}.ts`, context)
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:item-rates-feature-gates') {
      return {
        shortCircuit: true,
        format: 'module',
        source: `
          export async function guardFeaturePermission() {
            return globalThis[Symbol.for('openbooks.item-rates-pin-route-test')].gate
          }
        `,
      }
    }
    if (url === 'mock:item-rates-features') {
      return { shortCircuit: true, format: 'module', source: 'export async function isFeatureEnabled() { return true }' }
    }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?item-rates-pin-route-integration'
const { POST } = (await import(routeUrl)) as typeof import('./route')
const bookRouteUrl = '../../../item-rate-books/route.ts?item-rates-pin-book-integration'
const { POST: BOOKS_POST } = (await import(bookRouteUrl)) as typeof import('../../../item-rate-books/route')

const { db } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { resolveItemRate } = await import('../../../../../lib/item-rates.ts')
hooks.deregister()

const DB = Boolean(process.env.OPENBOOKS_DB_URL)

const TIERS = [
  { unitCode: 'one', unitName: 'One', baseQuantity: '1', costRate: '10', billRate: '10' },
  { unitCode: 'four', unitName: 'Four', baseQuantity: '4', costRate: '30', billRate: '30' },
  { unitCode: 'six', unitName: 'Six', baseQuantity: '6', costRate: '50', billRate: '50' },
]

function postRates(itemId: string, body: Record<string, unknown>) {
  return POST(new Request(`http://openbooks.test/api/items/${itemId}/rates`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: itemId }) })
}

/**
 * PRC1 writers: saving a new dated version pins the saved item's policy,
 * base unit and presentation onto the new version (never mutating the past).
 * January is saved through the book-replacement writer (two items, different
 * policies in one version); February through the single-item writer, which
 * must carry the other item's pin forward exactly like its lines.
 */
test('saving a version pins policy per item and carries other items forward', { skip: !DB }, async () => {
  const org = await createScratchOrg()
  try {
    routeState.gate = { user: { orgId: org.orgId, id: org.orgId } }
    const project = randomUUID(), book = randomUUID(), aide = randomUUID()
    await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
      values (${project}, ${org.orgId}, ${org.subsidiaryId}, 'PIN-WRITE', 'Pin writer job', ${org.customerId}, 'active', true, '{}'::jsonb)`)
    await db.execute(sql`insert into item_rate_books (id, org_id, code, name, currency, is_default, is_active)
      values (${book}, ${org.orgId}, 'PIN-WRITE', 'Pin writer book', 'CAD', false, true)`)
    await db.execute(sql`insert into item_rate_book_assignments (org_id, rate_book_id, date_basis, is_active)
      values (${org.orgId}, ${book}, 'usage_date', true)`)
    await db.execute(sql`insert into items (id, org_id, kind, name, show_on_timesheet, is_active, custom, create_plans_on, revenue_allocation)
      values (${aide}, ${org.orgId}, 'service', 'Pinning aide', false, true, '{}'::jsonb, 'billing', 'normal')`)

    const january = await BOOKS_POST(new Request('http://openbooks.test/api/item-rate-books', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: book, code: 'PIN-WRITE', name: 'Pin writer book', replaceRates: true, effectiveFrom: '2026-01-01',
        lines: [
          ...TIERS.map((tier) => ({
            ...tier, itemId: org.items.service, baseUnit: 'hour',
            pricingPolicy: 'capped_ladder', invoicePresentation: 'summary', timeTypeBillRates: {},
          })),
          {
            itemId: aide, unitCode: 'hour', unitName: 'Hour', baseQuantity: '1',
            costRate: '200', billRate: '200', baseUnit: 'hour',
            pricingPolicy: 'lowest_cost', invoicePresentation: 'rate_components', timeTypeBillRates: {},
          },
        ],
      }),
    }))
    assert.equal(january.status, 200, await january.text())

    const february = await postRates(org.items.service, {
      rateBookId: book, effectiveFrom: '2026-02-01', baseUnit: 'hour',
      pricingPolicy: 'lowest_cost', invoicePresentation: 'rate_components', tiers: TIERS,
    })
    assert.equal(february.status, 200, await february.text())

    const pins = (await db.execute<{ effective_from: string; item_id: string; pricing_policy: string }>(sql`
      select v.effective_from::text, p.item_id, p.pricing_policy
        from item_rate_version_profiles p
        join item_rate_versions v on v.id = p.version_id and v.org_id = p.org_id
       where p.org_id = ${org.orgId} and v.rate_book_id = ${book}
       order by v.effective_from, p.item_id`)).rows
    assert.deepEqual(
      pins
        .map((r) => [r.effective_from.slice(0, 10), r.item_id === org.items.service ? 'main' : 'aide', r.pricing_policy])
        .sort(),
      [
        ['2026-01-01', 'aide', 'lowest_cost'],
        ['2026-01-01', 'main', 'capped_ladder'],
        ['2026-02-01', 'aide', 'lowest_cost'],
        ['2026-02-01', 'main', 'lowest_cost'],
      ],
    )

    const base = { orgId: org.orgId, projectId: project, baseQuantity: '8' } as const
    assert.equal((await resolveItemRate({ ...base, itemId: org.items.service, onDate: '2026-01-15' }))?.bill.amount, '70.0000')
    assert.equal((await resolveItemRate({ ...base, itemId: org.items.service, onDate: '2026-02-15' }))?.bill.amount, '60.0000')
    const aideFeb = await resolveItemRate({ ...base, itemId: aide, onDate: '2026-02-15', baseQuantity: '1' })
    assert.equal(aideFeb?.bill.amount, '200.0000')
    assert.equal(aideFeb?.policy, 'lowest_cost')
  } finally {
    routeState.gate = null
    await dropScratchOrg(org.orgId)
  }
})

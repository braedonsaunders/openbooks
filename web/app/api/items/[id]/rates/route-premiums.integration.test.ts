import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { sql } from 'drizzle-orm'

const stateKey = Symbol.for('openbooks.item-rates-premiums-route-test')
const routeState: { gate: { user: { orgId: string; id: string } } | null } = { gate: null }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState

const webRoot = `${pathToFileURL(`${process.cwd()}/web/`).href}`
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    if (specifier.endsWith('/lib/feature-gates')) return { shortCircuit: true, url: 'mock:item-rates-premiums-gates' }
    if (specifier.endsWith('/lib/features')) return { shortCircuit: true, url: 'mock:item-rates-premiums-features' }
    if (specifier.startsWith('@/')) return nextResolve(`${webRoot}${specifier.slice(2)}.ts`, context)
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:item-rates-premiums-gates') {
      return {
        shortCircuit: true,
        format: 'module',
        source: `export async function guardFeaturePermission() { return globalThis[Symbol.for('openbooks.item-rates-premiums-route-test')].gate }`,
      }
    }
    if (url === 'mock:item-rates-premiums-features') {
      return { shortCircuit: true, format: 'module', source: 'export async function isFeatureEnabled() { return true }' }
    }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?item-rates-premiums-route-integration'
const { POST } = (await import(routeUrl)) as typeof import('./route')

const { db } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { resolveItemRate, snapshotTimeBillRates } = await import('../../../../../lib/item-rates.ts')
hooks.deregister()

const DB = Boolean(process.env.OPENBOOKS_DB_URL)

function post(itemId: string, body: Record<string, unknown>) {
  return POST(new Request(`http://openbooks.test/api/items/${itemId}/rates`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: itemId }) })
}

function tiered(book: string, from: string, premiums: Record<string, unknown>) {
  return {
    rateBookId: book, effectiveFrom: from, baseUnit: 'hour',
    pricingPolicy: 'capped_ladder', invoicePresentation: 'rate_components',
    tiers: [{ unitCode: 'hour', unitName: 'Hour', baseQuantity: '1', costRate: '100', billRate: '100', timeTypeBillRates: premiums }],
  }
}

async function fixture() {
  const org = await createScratchOrg()
  routeState.gate = { user: { orgId: org.orgId, id: org.orgId } }
  const book = randomUUID()
  await db.execute(sql`insert into item_rate_books (id, org_id, code, name, currency, is_default, is_active)
    values (${book}, ${org.orgId}, 'PREMIUMS', 'Premiums book', 'CAD', true, true)`)
  const timeType = randomUUID()
  await db.execute(sql`insert into time_types (id, org_id, name, bill_multiplier, is_active)
    values (${timeType}, ${org.orgId}, 'Overtime', '1.5', true)`)
  return { org, book, timeType }
}

async function versionCount(orgId: string, book: string) {
  return Number((await db.execute<{ count: string }>(sql`
    select count(*)::text as count from item_rate_versions where org_id = ${orgId} and rate_book_id = ${book}`)).rows[0]!.count)
}

/**
 * PRC5: per-time-type premiums save through ONE shared validator. An
 * invalid value, a non-UUID key, or another tenant's time-type id each
 * refuses by rate unit and key with no write — never filtered silently —
 * and the prior version stands.
 */
test('bad premiums refuse by rate unit and key with no write', { skip: !DB }, async () => {
  const { org, book } = await fixture()
  const foreign = await createScratchOrg()
  try {
    const first = await post(org.items.service, tiered(book, '2026-01-01', {}))
    assert.equal(first.status, 200, await first.text())

    const badValue = await post(org.items.service, tiered(book, '2026-02-01', { 'not-a-uuid': 'abc' }))
    assert.equal(badValue.status, 422)
    assert.match(String((await badValue.json()).error), /Rate unit 1: labor premium "not-a-uuid" is not a valid time type/)

    const foreignType = randomUUID()
    await db.execute(sql`insert into time_types (id, org_id, name, bill_multiplier, is_active)
      values (${foreignType}, ${foreign.orgId}, 'Foreign', '2', true)`)
    const foreignKey = await post(org.items.service, tiered(book, '2026-02-01', { [foreignType]: '150' }))
    assert.equal(foreignKey.status, 422)
    assert.match(String((await foreignKey.json()).error), new RegExp(`Rate unit 1: labor premium "${foreignType}" is not an active time type`))

    assert.equal(await versionCount(org.orgId, book), 1)
  } finally {
    routeState.gate = null
    await dropScratchOrg(org.orgId)
    await dropScratchOrg(foreign.orgId)
  }
})

test('an invalid premium value and an over-wide premium refuse', { skip: !DB }, async () => {
  const { org, book, timeType } = await fixture()
  try {
    const first = await post(org.items.service, tiered(book, '2026-01-01', {}))
    assert.equal(first.status, 200, await first.text())

    const badValue = await post(org.items.service, tiered(book, '2026-02-01', { [timeType]: 'twelve' }))
    assert.equal(badValue.status, 422)
    assert.match(String((await badValue.json()).error), new RegExp(`Rate unit 1: labor premium for time type "${timeType}" must be a non-negative amount`))

    const overWide = await post(org.items.service, tiered(book, '2026-02-01', { [timeType]: '9999999999999999.0000' }))
    assert.equal(overWide.status, 422)
    assert.match(String((await overWide.json()).error), new RegExp(`Rate unit 1: labor premium for time type "${timeType}" must be a non-negative amount`))

    assert.equal(await versionCount(org.orgId, book), 1)
  } finally {
    routeState.gate = null
    await dropScratchOrg(org.orgId)
  }
})

test('a valid premium map saves and applies at snapshot', { skip: !DB }, async () => {
  const { org, book, timeType } = await fixture()
  try {
    const saved = await post(org.items.service, tiered(book, '2026-01-01', { [timeType]: '300' }))
    assert.equal(saved.status, 200, await saved.text())

    const stored = (await db.execute<{ time_type_bill_rates: Record<string, string> }>(sql`
      select time_type_bill_rates from item_rate_lines where org_id = ${org.orgId} and item_id = ${org.items.service}`)).rows[0]
    assert.deepEqual(stored!.time_type_bill_rates, { [timeType]: '300.0000' })

    const project = randomUUID(), employee = randomUUID(), entry = randomUUID()
    await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
      values (${employee}, ${org.orgId}, 'employee', 'Premium worker', ${org.subsidiaryId}, true, '{}'::jsonb)`)
    await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
      values (${project}, ${org.orgId}, ${org.subsidiaryId}, 'PREMIUM', 'Premium job', ${org.customerId}, 'active', true, '{}'::jsonb)`)
    await db.execute(sql`insert into time_entries (id, org_id, employee_party_id, worked_on, hours, item_id, project_id, time_type_id,
                            status, is_billable, billing_status, custom, created_by, updated_by)
      values (${entry}, ${org.orgId}, ${employee}, '2026-01-15', '2.0000', ${org.items.service}, ${project}, ${timeType},
              'approved', true, 'unbilled', '{}'::jsonb, ${org.orgId}, ${org.orgId})`)
    // The explicit premium wins over bill_rate × multiplier (100 × 1.5).
    assert.equal((await snapshotTimeBillRates(org.orgId, [entry], { dryRun: true })).get(entry), '300.0000')
    assert.ok(await resolveItemRate({ orgId: org.orgId, projectId: project, itemId: org.items.service, onDate: '2026-01-15', baseQuantity: '1' }))
  } finally {
    routeState.gate = null
    await dropScratchOrg(org.orgId)
  }
})

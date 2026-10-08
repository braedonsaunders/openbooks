import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

const stateKey = Symbol.for('openbooks.item-rate-books-replacement-test')
const routeState: {
  gate: { user: { orgId: string; id: string }; allowedSubsidiaryIds: null } | null
} = { gate: null }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('/lib/feature-gates')) return { shortCircuit: true, url: 'mock:rate-books-feature-gates' }
    if (specifier.endsWith('/lib/features')) return { shortCircuit: true, url: 'mock:rate-books-features' }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:rate-books-feature-gates') {
      return {
        shortCircuit: true,
        format: 'module',
      source: `export async function guardFeaturePermission() { return globalThis[Symbol.for('openbooks.item-rate-books-replacement-test')].gate }`,
      }
    }
    if (url === 'mock:rate-books-features') {
      return { shortCircuit: true, format: 'module', source: 'export async function isFeatureEnabled() { return true }' }
    }
    return nextLoad(url, context)
  },
})

const bookRouteUrl = './route.ts?item-rate-books-replacement-integration'
const { POST } = (await import(bookRouteUrl)) as typeof import('./route')

const { withBypassContext, withOrgContext, db } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { resolveItemRate } = await import('../../../lib/item-rates.ts')
test.after(() => hooks.deregister())


function bookPost(body: Record<string, unknown>) {
  return POST(new Request('http://openbooks.test/api/item-rate-books', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

function tiers(itemId: string, premiums: Record<string, unknown> = {}) {
  return [
    {
      itemId, unitCode: 'one', unitName: 'One', baseQuantity: '1', costRate: '10', billRate: '10',
      baseUnit: 'hour', pricingPolicy: 'capped_ladder', invoicePresentation: 'summary', timeTypeBillRates: premiums,
    },
    {
      itemId, unitCode: 'four', unitName: 'Four', baseQuantity: '4', costRate: '30', billRate: '30',
      baseUnit: 'hour', pricingPolicy: 'capped_ladder', invoicePresentation: 'summary', timeTypeBillRates: premiums,
    },
  ]
}

async function fixture() {
  const org = await withBypassContext(() => (createScratchOrg()))
  routeState.gate = { user: { orgId: org.orgId, id: org.orgId }, allowedSubsidiaryIds: null }
  const book = randomUUID()
  await withBypassContext(() => (db.execute(sql`insert into item_rate_books (id, org_id, code, name, currency, is_default, is_active)
    values (${book}, ${org.orgId}, 'REPLACE', 'Replacement book', 'CAD', false, true)`)))
  return { org, book }
}

async function activeVersions(orgId: string, book: string) {
  return (await withOrgContext(orgId, () => db.execute<{ id: string; effective_from: string; effective_to: string | null }>(sql`
    select id, effective_from::text, effective_to::text from item_rate_versions
     where org_id = ${orgId} and rate_book_id = ${book} and status = 'active'
     order by effective_from`))).rows
}

async function lineCount(orgId: string, versionId: string) {
  return (await withOrgContext(orgId, () => db.execute<{ count: string }>(sql`
    select count(*)::text as count from item_rate_lines where org_id = ${orgId} and version_id = ${versionId}`))).rows[0]!.count
}

test('bounded rate versions retain expiry gaps and resolve only their recorded windows', async () => {
  const { org, book } = await fixture()
  try {
    const project = randomUUID()
    await withBypassContext(() => db.execute(sql`
      insert into projects (id,org_id,subsidiary_id,code,name,customer_id,status,is_active,custom)
      values (${project},${org.orgId},${org.subsidiaryId},'BOUNDED','Bounded rates',${org.customerId},'active',true,'{}'::jsonb)`))
    await withBypassContext(() => db.execute(sql`
      insert into item_rate_book_assignments (org_id,rate_book_id,project_id,date_basis,is_active)
      values (${org.orgId},${book},${project},'usage_date',true)`))
    const post = (effectiveFrom: string, effectiveTo: string | null) => bookPost({
      id: book, code: 'REPLACE', name: 'Replacement book', replaceRates: true,
      effectiveFrom, effectiveTo, lines: tiers(org.items.service),
    })
    const original = await post('2025-01-01', '2025-12-31')
    assert.equal(original.status, 200, await original.text())
    const before = (await activeVersions(org.orgId, book))[0]!
    const originalLines = await withOrgContext(org.orgId, () => db.execute(sql`
      select * from item_rate_lines where org_id=${org.orgId} and version_id=${before.id} order by id`))
    const replacement = await post('2026-02-01', '2026-02-28')
    assert.equal(replacement.status, 200, await replacement.text())
    const versions = await activeVersions(org.orgId, book)
    assert.deepEqual(versions[0], before, 'a later version cannot extend the prior expiry into the gap')
    assert.equal(versions[1]!.effective_to, '2026-02-28')
    assert.deepEqual((await withOrgContext(org.orgId, () => db.execute(sql`
      select * from item_rate_lines where org_id=${org.orgId} and version_id=${before.id} order by id`))).rows, originalLines.rows)
    const resolve = (onDate: string) => resolveItemRate({
      orgId: org.orgId, projectId: project, itemId: org.items.service, onDate, baseQuantity: '1',
    })
    assert.equal((await resolve('2025-12-31'))?.rateVersionId, before.id)
    assert.equal(await resolve('2026-01-15'), null, 'an intentional unpriced gap must stay unpriced')
    assert.equal((await resolve('2026-02-28'))?.rateVersionId, versions[1]!.id)
    assert.equal(await resolve('2026-03-01'), null)
    const open = await post('2026-03-01', null)
    assert.equal(open.status, 200, await open.text())
    assert.equal((await activeVersions(org.orgId, book))[2]!.effective_to, null)
    const audits = (await withOrgContext(org.orgId, () => db.execute<{
      actor_id: string; changes: { effectiveTo: string | null; closedVersion: unknown };
    }>(sql`select actor_id,changes from audit_log where org_id=${org.orgId} and table_name='item_rate_versions' order by at,id`))).rows
    assert.equal(audits.length, 3)
    assert.ok(audits.every((audit) => audit.actor_id === org.orgId))
    assert.deepEqual(audits.map((audit) => audit.changes.effectiveTo), ['2025-12-31', '2026-02-28', null])
    assert.ok(audits.every((audit) => audit.changes.closedVersion === null), 'previous ended versions were not changed')
  } finally {
    routeState.gate = null
    await dropScratchOrg(org.orgId)
  }
})

test('invalid or reversed version end dates refuse before header, pricing or audit changes', async () => {
  const { org, book } = await fixture()
  try {
    const snapshot = async () => withOrgContext(org.orgId, () => db.execute(sql`
      select jsonb_build_object(
        'book',(select to_jsonb(b) from item_rate_books b where b.org_id=${org.orgId} and b.id=${book}),
        'versions',(select jsonb_agg(to_jsonb(v) order by id) from item_rate_versions v where v.org_id=${org.orgId} and v.rate_book_id=${book}),
        'profiles',(select jsonb_agg(to_jsonb(p) order by id) from item_rate_profiles p where p.org_id=${org.orgId}),
        'lines',(select jsonb_agg(to_jsonb(l) order by id) from item_rate_lines l where l.org_id=${org.orgId}),
        'audit',(select jsonb_agg(to_jsonb(a) order by id) from audit_log a where a.org_id=${org.orgId})
      ) as evidence`))
    const before = (await snapshot()).rows
    for (const effectiveTo of ['2026-02-30', '2025-12-31', 'tomorrow']) {
      const refused = await bookPost({ id: book, code: 'REPLACE', name: 'Changed name', replaceRates: true,
        effectiveFrom: '2026-01-01', effectiveTo, lines: tiers(org.items.service) })
      assert.equal(refused.status, 422)
      assert.match(String((await refused.json()).error), /Effective to.*real calendar date.*on or after/)
      assert.deepEqual((await snapshot()).rows, before)
    }
  } finally {
    routeState.gate = null
    await dropScratchOrg(org.orgId)
  }
})

/**
 * PRC4: a partly filled row is refused by index naming the missing field,
 * and a replacement that would activate an empty version is refused without
 * an explicit confirmation. Every refusal runs before the transaction, so
 * the current active version stays intact.
 */
test('a partly filled row refuses by index and leaves the version intact', async () => {
  const { org, book } = await fixture()
  try {
    const first = await bookPost({ id: book, code: 'REPLACE', name: 'Replacement book', replaceRates: true, effectiveFrom: '2026-01-01', lines: tiers(org.items.service) })
    assert.equal(first.status, 200, await first.text())

    const partial = await bookPost({
      id: book, code: 'REPLACE', name: 'Replacement book', replaceRates: true, effectiveFrom: '2026-02-01',
      lines: [{ itemId: '', unitCode: '', unitName: '', baseQuantity: '1', billRate: '100', costRate: '50', baseUnit: '', pricingPolicy: '', invoicePresentation: '', timeTypeBillRates: {} }],
    })
    assert.equal(partial.status, 422)
    assert.match(String((await partial.json()).error), /^Row 1: choose an item/)

    const versions = await activeVersions(org.orgId, book)
    assert.equal(versions.length, 1)
    assert.equal(String(versions[0]!.effective_from).slice(0, 10), '2026-01-01')
    assert.equal(versions[0]!.effective_to, null)
    assert.equal(await lineCount(org.orgId, versions[0]!.id), '2')
  } finally {
    routeState.gate = null
    await dropScratchOrg(org.orgId)
  }
})

test('an empty replacement refuses without the flag and clears with it', async () => {
  const { org, book } = await fixture()
  try {
    const first = await bookPost({ id: book, code: 'REPLACE', name: 'Replacement book', replaceRates: true, effectiveFrom: '2026-01-01', lines: tiers(org.items.service) })
    assert.equal(first.status, 200, await first.text())

    const empty = await bookPost({ id: book, code: 'REPLACE', name: 'Replacement book', replaceRates: true, effectiveFrom: '2026-02-01', lines: [] })
    assert.equal(empty.status, 422)
    assert.match(String((await empty.json()).error), /clear every rate/)
    assert.equal((await activeVersions(org.orgId, book)).length, 1)

    const blankOnly = await bookPost({
      id: book, code: 'REPLACE', name: 'Replacement book', replaceRates: true, effectiveFrom: '2026-02-01',
      lines: [{ itemId: '', unitCode: '', unitName: '', baseQuantity: '', costRate: '', billRate: '', baseUnit: '', pricingPolicy: '', invoicePresentation: '' }],
    })
    assert.equal(blankOnly.status, 422)
    assert.match(String((await blankOnly.json()).error), /clear every rate/)
    assert.equal((await activeVersions(org.orgId, book)).length, 1)

    const confirmed = await bookPost({
      id: book, code: 'REPLACE', name: 'Replacement book', replaceRates: true, effectiveFrom: '2026-02-01',
      confirmEmptyReplacement: true, lines: [],
    })
    assert.equal(confirmed.status, 200, await confirmed.text())
    // Closing is date-based: the January version stays status-active but
    // ended, and the empty February version is the live one.
    const versions = await activeVersions(org.orgId, book)
    assert.equal(versions.length, 2)
    const live = versions.find((v) => String(v.effective_from).slice(0, 10) === '2026-02-01')!
    assert.equal(await lineCount(org.orgId, live.id), '0')
    const closed = (await withOrgContext(org.orgId, () => db.execute<{ effective_to: string }>(sql`
      select effective_to::text from item_rate_versions
       where org_id = ${org.orgId} and rate_book_id = ${book} and effective_from = '2026-01-01'`))).rows[0]
    assert.equal(String(closed!.effective_to).slice(0, 10), '2026-01-31')
    const closure = (await withOrgContext(org.orgId, () => db.execute<{ changes: { closedVersion: unknown } }>(sql`
      select changes from audit_log where org_id=${org.orgId} and table_name='item_rate_versions' and row_id=${live.id}`))).rows[0]!
    assert.deepEqual(closure.changes.closedVersion, { id: versions[0]!.id, before: { effectiveTo: null }, after: { effectiveTo: '2026-01-31' } })
  } finally {
    routeState.gate = null
    await dropScratchOrg(org.orgId)
  }
})

/**
 * PRC5 wiring: the replacement writer validates premiums through the shared
 * validator, so an unknown time type or an invalid premium value refuses by
 * row and key with the prior version intact.
 */
test('unknown time types and premium values refuse with the version intact', async () => {
  const { org, book } = await fixture()
  try {
    const timeType = randomUUID()
    await withBypassContext(() => (db.execute(sql`insert into time_types (id, org_id, name, bill_multiplier, is_active)
      values (${timeType}, ${org.orgId}, 'Night', '1.25', true)`)))
    const first = await bookPost({ id: book, code: 'REPLACE', name: 'Replacement book', replaceRates: true, effectiveFrom: '2026-01-01', lines: tiers(org.items.service) })
    assert.equal(first.status, 200, await first.text())

    const unknown = randomUUID()
    const refused = await bookPost({
      id: book, code: 'REPLACE', name: 'Replacement book', replaceRates: true, effectiveFrom: '2026-02-01',
      lines: tiers(org.items.service, { [unknown]: '50' }),
    })
    assert.equal(refused.status, 422)
    assert.match(String((await refused.json()).error), new RegExp(`Row 1: labor premium "${unknown}" is not an active time type`))

    const badValue = await bookPost({
      id: book, code: 'REPLACE', name: 'Replacement book', replaceRates: true, effectiveFrom: '2026-02-01',
      lines: tiers(org.items.service, { [timeType]: 'fifty' }),
    })
    assert.equal(badValue.status, 422)
    assert.match(String((await badValue.json()).error), new RegExp(`Row 1: labor premium for time type "${timeType}" must be a non-negative amount`))

    const versions = await activeVersions(org.orgId, book)
    assert.equal(versions.length, 1)
    assert.equal(String(versions[0]!.effective_from).slice(0, 10), '2026-01-01')
  } finally {
    routeState.gate = null
    await dropScratchOrg(org.orgId)
  }
})

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const route = await readFile(new URL('./route.ts', import.meta.url), 'utf8')
const resources = await readFile(new URL('../../../../lib/data-io/resources.ts', import.meta.url), 'utf8')
const transactions = await readFile(new URL('../../../../lib/data-io/transaction-resources.ts', import.meta.url), 'utf8')
const core = await readFile(new URL('../../../../lib/data-io/resource-core.ts', import.meta.url), 'utf8')

test('generic export binds the caller subsidiary scope before reading a resource', () => {
  // Regression: before this binding, the route passed only orgId to
  // getResource and transaction reads returned every subsidiary's documents.
  assert.match(
    route,
    /getResource\(authz\.user\.orgId, resourceKey, authz\.allowedSubsidiaryIds\)/,
  )
  assert.match(route, /resource\.read\(\{\s*allowedSubsidiaryIds: authz\.allowedSubsidiaryIds/)
  assert.match(resources, /function bindReadScope\(/)
  assert.match(resources, /resource\.read\(\{ allowedSubsidiaryIds: effectiveScope \}\)/)
  assert.match(transactions, /transactionSubsidiaryFilter\(subsidiaryScope\)/)
})

test('unrestricted exports remain a pass-through while restricted scopes fail closed', () => {
  // Happy path: null is the explicit unrestricted sentinel; an empty
  // allow-list must become `and false`, never an unscoped query.
  assert.match(resources, /if \(effectiveScope === null\) return result/)
  assert.match(
    resources,
    /subsidiaryReadFilter\(sql`p\.subsidiary_id`, scope\)/,
  )
  assert.match(
    core,
    /if \(ids\.length === 0\) return sql` and false`/,
  )
})

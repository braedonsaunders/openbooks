import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    return next(specifier, context)
  },
})

import type { LineStockLocationScope } from './stock-locations.ts'

const { resolveLineStockLocation } = await import('./stock-locations.ts')

// The warehouse decision table, pinned without a database: explicit choices
// validate, blanks default only when the org has exactly one active location
// and the item is stocked.
const A = { id: 'aaaaaaaa-0000-4000-8000-000000000001', code: 'MAIN' }
const B = { id: 'bbbbbbbb-0000-4000-8000-000000000002', code: 'STAGE' }
const ITEM = 'cccccccc-0000-4000-8000-000000000003'
const multi: LineStockLocationScope = { active: [A, B], profiled: new Set([ITEM]) }
const single: LineStockLocationScope = { active: [A], profiled: new Set([ITEM]) }

test('an explicit active warehouse is kept', () => {
  assert.deepEqual(resolveLineStockLocation(1, ITEM, A.id, multi), { locationId: A.id })
})

test('malformed and non-active warehouses fail naming the line', () => {
  assert.deepEqual(resolveLineStockLocation(2, ITEM, 'nope', multi), {
    error: 'Line 2: invalid stock location',
  })
  assert.deepEqual(
    resolveLineStockLocation(3, ITEM, 'dddddddd-0000-4000-8000-000000000004', single),
    { error: 'Line 3: stock location is not an active warehouse in this organization' },
  )
})

test('a blank stocked line defaults only with exactly one location', () => {
  assert.deepEqual(resolveLineStockLocation(1, ITEM, null, multi), { locationId: null })
  assert.deepEqual(resolveLineStockLocation(1, ITEM, null, single), { locationId: A.id })
  assert.deepEqual(resolveLineStockLocation(1, ITEM, undefined, single), { locationId: A.id })
})

test('blank lines for non-stocked items stay blank', () => {
  assert.deepEqual(resolveLineStockLocation(1, 'eeeeeeee-0000-4000-8000-000000000005', null, single), {
    locationId: null,
  })
  assert.deepEqual(resolveLineStockLocation(1, null, null, single), { locationId: null })
})

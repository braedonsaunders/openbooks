import assert from 'node:assert/strict'
import test from 'node:test'
import { buildListDrawerHref, hasActiveListFilters, isUuid } from './list-params'

test('isUuid accepts canonical UUIDs and rejects malformed route ids', () => {
  const canonicalIds = [
    '019f68a5-6a24-78ec-bed6-cc04e06f2078',
    '550e8400-e29b-41d4-a716-446655440000',
    '019F68A5-6A24-78EC-BED6-CC04E06F2078',
  ]
  for (const id of canonicalIds) {
    assert.equal(isUuid(id), true, `canonical UUID should be accepted: ${id}`)
  }

  const malformedIds = [
    '-'.repeat(36),
    '019f68a5-6a24-78ec-bed6-cc04e06f207',
    '019f68a5-6a24-78ec-bed6-cc04e06f2078x',
    '019f68a5-6a24-78ec-bed6-cc04e06f207g',
    '019f68a56a2478ecbed6cc04e06f2078',
    '019f68a5-6a24-78ec-bed6-cc04e06f20-78',
  ]
  for (const id of malformedIds) {
    assert.equal(isUuid(id), false, `malformed UUID should be rejected: ${id}`)
  }
})

test('list drawer href preserves all query-backed list state for close', () => {
  const href = buildListDrawerHref(
    '/projects',
    {
      q: 'gyp',
      status: 'active',
      billing: 'fixed_price',
      view: 'margin-review',
      sort: 'name',
      dir: 'desc',
      page: '3',
      perPage: '50',
    },
    'project',
    '019f68a5-6a24-78ec-bed6-cc04e06f2078',
  )

  const url = new URL(href, 'https://openbooks.example')
  assert.equal(url.searchParams.get('project'), '019f68a5-6a24-78ec-bed6-cc04e06f2078')
  assert.equal(
    url.searchParams.get('drawerReturn'),
    '/projects?q=gyp&status=active&billing=fixed_price&view=margin-review&sort=name&dir=desc&page=3&perPage=50',
  )
})

test('list drawer href replaces stale drawer context instead of nesting it', () => {
  const href = buildListDrawerHref(
    '/bills',
    {
      q: 'steel',
      status: 'pending_approval',
      doc: 'old-record',
      drawerReturn: '/bills?q=old',
    },
    'doc',
    'new-record',
  )

  const url = new URL(href, 'https://openbooks.example')
  assert.equal(url.searchParams.get('doc'), 'new-record')
  assert.equal(
    url.searchParams.get('drawerReturn'),
    '/bills?q=steel&status=pending_approval',
  )
  assert.equal(url.searchParams.getAll('drawerReturn').length, 1)
})

test('an unfiltered list is not filter-active, so the empty state may use page copy', () => {
  // UX-08b: "no imports yet" and "filters match nothing" need different copy
  // AND different actions. Only a truly unfiltered shell may render the
  // page-specific "nothing here yet" copy.
  assert.equal(
    hasActiveListFilters({ q: undefined, quickValues: {}, savedViewFilterCount: 0 }),
    false,
  )
})

test('a search term marks the list filter-active even when it is only whitespace-padded', () => {
  assert.equal(
    hasActiveListFilters({ q: '  ofx  ', quickValues: {}, savedViewFilterCount: 0 }),
    true,
  )
  assert.equal(
    hasActiveListFilters({ q: '   ', quickValues: {}, savedViewFilterCount: 0 }),
    false,
  )
})

test('an applied quick filter marks the list filter-active, requested or defaulted', () => {
  assert.equal(
    hasActiveListFilters({ q: undefined, quickValues: { source: 'manual' }, savedViewFilterCount: 0 }),
    true,
  )
  // A defaulted chip still narrows the list, so it still counts.
  assert.equal(
    hasActiveListFilters({ q: undefined, quickValues: { source: 'all' }, savedViewFilterCount: 0 }),
    true,
  )
  // An explicitly cleared ('all' → undefined) chip does not.
  assert.equal(
    hasActiveListFilters({ q: undefined, quickValues: { source: undefined }, savedViewFilterCount: 0 }),
    false,
  )
})

test('a saved-view filter marks the list filter-active', () => {
  assert.equal(
    hasActiveListFilters({ q: undefined, quickValues: {}, savedViewFilterCount: 2 }),
    true,
  )
})

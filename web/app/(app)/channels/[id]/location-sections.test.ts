import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { conflictsForLocation, dedupeConflicts, resolveLocationSection } from './location-sections.ts'

describe('resolveLocationSection', () => {
  it('honours each explicit section', () => {
    assert.equal(resolveLocationSection({ section: 'mapped' }), 'mapped')
    assert.equal(resolveLocationSection({ section: 'policies' }), 'policies')
  })

  it('falls back to mapped for unknown or absent sections', () => {
    assert.equal(resolveLocationSection({ section: 'bogus' }), 'mapped')
    assert.equal(resolveLocationSection({}), 'mapped')
  })
})

describe('conflictsForLocation', () => {
  const conflicts = [
    { id: 'c1', stockLocationId: 's1' },
    { id: 'c2', stockLocationId: 's2' },
    { id: 'c3', stockLocationId: 's1' },
  ]
  it('returns only the selected location conflicts', () => {
    assert.deepEqual(
      conflictsForLocation(conflicts, 's1').map((c) => c.id),
      ['c1', 'c3'],
    )
  })
  it('returns none for an unmapped location', () => {
    assert.deepEqual(conflictsForLocation(conflicts, null), [])
    assert.deepEqual(conflictsForLocation(conflicts, 's9'), [])
  })

  // A conflict with no push-state row stays reachable from its location row,
  // and review opens only the selected identity: covered by the rendered
  // network-double test in ./locations-tab.test.tsx, which asserts the
  // review button and the drawer contents instead of an unused variable.
})

describe('dedupeConflicts', () => {
  it('collapses join duplicates by conflict identity, keeping order', () => {
    const rows = [
      { id: 'c1', stockLocationId: 's1' },
      { id: 'c2', stockLocationId: 's1' },
      { id: 'c1', stockLocationId: 's1' },
    ]
    assert.deepEqual(
      dedupeConflicts(rows).map((c) => c.id),
      ['c1', 'c2'],
    )
  })

  it('drops no real records', () => {
    const rows = [
      { id: 'c1', stockLocationId: 's1' },
      { id: 'c2', stockLocationId: 's2' },
    ]
    assert.equal(dedupeConflicts(rows).length, 2)
  })
})

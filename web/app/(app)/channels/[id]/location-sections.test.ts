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

  it('keeps a listed conflict reachable when its push state row is gone', () => {
    // An unlinked variant leaves the conflict in the queue with zero state
    // rows; reachability comes from the loaded conflicts, never the states.
    const states: { openConflicts: number }[] = []
    const reachable = conflictsForLocation(conflicts, 's1')
    assert.equal(reachable.length, 2)
    assert.equal(states.length, 0)
  })
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

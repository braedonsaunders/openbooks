import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { conflictsForLocation, resolveLocationSection } from './location-sections.ts'

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
})

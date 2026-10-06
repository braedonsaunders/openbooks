import assert from 'node:assert/strict'
import test from 'node:test'
import { parseStoredRecents, recentStorageKey, rememberRecent, type StoredRecent } from './search-recent.ts'
import { RECENT_LIMIT } from './search-types.ts'

test('recents are scoped to one user in one organization', () => {
  assert.notEqual(recentStorageKey('org-a:user-1'), recentStorageKey('org-b:user-1'))
  assert.notEqual(recentStorageKey('org-a:user-1'), recentStorageKey('org-a:user-2'))
})

test('a reopened result moves to the front once, and the list stays bounded', () => {
  let list: StoredRecent[] = []
  for (let index = 0; index < RECENT_LIMIT + 3; index++) {
    list = rememberRecent(list, { type: 'contact', id: `party-${index}` })
  }
  assert.equal(list.length, RECENT_LIMIT)
  list = rememberRecent(list, { type: 'contact', id: 'party-5' })
  assert.deepEqual(list[0], { type: 'contact', id: 'party-5' })
  assert.equal(list.filter((entry) => entry.id === 'party-5').length, 1)
  // The same id under another type is a different result.
  list = rememberRecent(list, { type: 'page', id: 'party-5' })
  assert.equal(list.filter((entry) => entry.id === 'party-5').length, 2)
})

test('stored references carry only a type and an id, and anything else is dropped', () => {
  const raw = JSON.stringify([
    { type: 'transaction', id: 'doc-1' },
    { type: 'page', id: '/journal' },
    { type: 'unknown-kind', id: 'x' },
    { type: 'contact' },
    { type: 'contact', id: '' },
    'not-an-object',
    null,
  ])
  assert.deepEqual(parseStoredRecents(raw), [
    { type: 'transaction', id: 'doc-1' },
    { type: 'page', id: '/journal' },
  ])
  assert.deepEqual(parseStoredRecents('{not json'), [])
  assert.deepEqual(parseStoredRecents(JSON.stringify({ type: 'contact', id: 'a' })), [])
  assert.deepEqual(parseStoredRecents(null), [])
})

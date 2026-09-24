import assert from 'node:assert/strict'
import test from 'node:test'
import { BULK_ACTION_MAX_IDS, parseBulkActionIds } from './bulk-ids.ts'

// F1-6b: the bulk route silently truncated the deduplicated ids with
// .slice(0, 50) and reported success for just those 50 — 50 documents were
// never attempted while the toast claimed them done. Over-limit batches
// are now refused by name, and every requested id gets exactly one
// verdict. These tests drive the pure parse with independent values.
const uuid = (n: number): string =>
  `019f0000-0000-4000-8000-${String(n).padStart(12, '0')}`

test('up to the ceiling parses with dedupe', () => {
  const ids = [uuid(1), uuid(2), uuid(1)]
  assert.deepEqual(parseBulkActionIds({ action: 'reject', ids }), {
    ok: true,
    action: 'reject',
    ids: [uuid(1), uuid(2)],
  })
})

test('one id over the ceiling is refused by name, never truncated', () => {
  const ids = Array.from({ length: BULK_ACTION_MAX_IDS + 1 }, (_, i) => uuid(i))
  const parsed = parseBulkActionIds({ action: 'reject', ids })
  assert.equal(parsed.ok, false)
  assert.match((parsed as { error: string }).error, /^too_many_ids/)
  assert.match((parsed as { error: string }).error, /50/)
})

test('a hundred ids are refused by name', () => {
  const ids = Array.from({ length: 100 }, (_, i) => uuid(i))
  assert.deepEqual(parseBulkActionIds({ action: 'materialize', ids }), {
    ok: false,
    error: `too_many_ids: at most ${BULK_ACTION_MAX_IDS} ids per request`,
  })
})

test('exactly the ceiling still parses', () => {
  const ids = Array.from({ length: BULK_ACTION_MAX_IDS }, (_, i) => uuid(i))
  const parsed = parseBulkActionIds({ action: 'reprocess', ids })
  assert.equal(parsed.ok, true)
  assert.equal((parsed as { ids: string[] }).ids.length, BULK_ACTION_MAX_IDS)
})

test('a bad action reads invalid_action even with bad ids', () => {
  assert.deepEqual(parseBulkActionIds({ action: 'explode', ids: [] }), {
    ok: false,
    error: 'invalid_action',
  })
  assert.deepEqual(parseBulkActionIds({ action: 'reject', ids: [] }), {
    ok: false,
    error: 'invalid_action',
  })
})

test('a 36-character non-uuid reads not_found, never reaching the id column', () => {
  assert.deepEqual(
    parseBulkActionIds({ action: 'reject', ids: ['------------------------------------'] }),
    { ok: false, error: 'not_found' },
  )
})

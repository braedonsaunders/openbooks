import assert from 'node:assert/strict'
import test from 'node:test'
import { groupEntryLinesByContributor } from './journal-entry-link'

const line = (n: number, contributor?: { kind: string; ref?: string | null; name?: string | null }) => ({
  line_number: n,
  contributor_kind: contributor?.kind ?? null,
  contributor_ref: contributor?.ref ?? null,
  contributor_name: contributor?.name ?? null,
})

test('standard lines come first, then one group per contributor in order', () => {
  const groups = groupEntryLinesByContributor([
    line(1, { kind: 'rule', ref: 'v-1', name: 'Overhead pair' }),
    line(2),
    line(3, { kind: 'rule', ref: 'v-1', name: 'Overhead pair' }),
    line(4, { kind: 'script', ref: 's-9', name: 'Custom plug' }),
    line(5),
  ])
  assert.deepEqual(groups.map((g) => g.key), ['standard', 'rule:v-1', 'script:s-9'])
  assert.deepEqual(groups[0]!.lines.map((l) => l.line_number), [2, 5])
  assert.deepEqual(groups[1]!.lines.map((l) => l.line_number), [1, 3])
  assert.equal(groups[1]!.name, 'Overhead pair')
  assert.equal(groups[0]!.kind, null)
})

test('entries without contributors stay a single standard group', () => {
  const groups = groupEntryLinesByContributor([line(1), line(2)])
  assert.equal(groups.length, 1)
  assert.equal(groups[0]!.key, 'standard')
})

test('contributor-only entries omit the standard group', () => {
  const groups = groupEntryLinesByContributor([line(1, { kind: 'rule', ref: 'v-2' })])
  assert.deepEqual(groups.map((g) => g.key), ['rule:v-2'])
  assert.equal(groups[0]!.name, null)
})

test('a late-arriving contributor name backfills the group label', () => {
  const groups = groupEntryLinesByContributor([
    line(1, { kind: 'rule', ref: 'v-3' }),
    line(2, { kind: 'rule', ref: 'v-3', name: 'Late name' }),
  ])
  assert.equal(groups[0]!.name, 'Late name')
})

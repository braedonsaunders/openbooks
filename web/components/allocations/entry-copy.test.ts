import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * The entry-mode distribution UI renders every string through
 * `allocations.entry.*` (no literals in JSX). A missing key is silent at
 * runtime — next-intl renders the raw path — so the contract is pinned here.
 */
const catalog = JSON.parse(
  readFileSync(new URL('../../messages/en/allocations.json', import.meta.url), 'utf8'),
) as { entry?: Record<string, string> }

const REQUIRED_ENTRY_KEYS = [
  'distributionColumn',
  'split',
  'unSplit',
  'lockGroup',
  'unlockGroup',
  'groupLockedHint',
  'groupTotalLabel',
  'groupTotalAria',
  'suggestSplit',
  'pendingRule',
  'applyAutomatic',
  'splitTitle',
  'ruleLabel',
  'rulePlaceholder',
  'handEditHeading',
  'handEditHint',
  'childrenTotalError',
  'dialogApply',
  'dialogCancel',
  'noCandidates',
  'candidatesFailed',
  'groupActionsAria',
] as const

test('every entry-mode distribution key exists and is non-empty', () => {
  const entry: Record<string, unknown> = catalog.entry ?? {}
  assert.ok(catalog.entry, 'allocations.json must carry an entry namespace')
  for (const key of REQUIRED_ENTRY_KEYS) {
    const value: unknown = entry[key]
    assert.equal(typeof value, 'string', `allocations.entry.${key} must exist`)
    assert.ok((value as string).trim().length > 0, `allocations.entry.${key} must not be empty`)
  }
})

test('entry copy carries no interpolation other than named {args}', () => {
  for (const [key, value] of Object.entries(catalog.entry ?? {}) as [string, string][]) {
    for (const match of value.match(/\{[^}]*\}/g) ?? []) {
      assert.match(match, /^\{[a-zA-Z][a-zA-Z0-9]*\}$/, `allocations.entry.${key} has a malformed placeholder ${match}`)
    }
  }
})

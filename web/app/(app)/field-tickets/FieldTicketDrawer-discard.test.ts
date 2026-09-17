import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// F-t04-005: New ticket persists an empty server-side draft on click, Cancel
// orphans it, and nothing could remove it. The drawer must offer Discard on
// drafts, close pristine shells back out automatically, and pin a refused
// discard as an alert instead of only toasting.
const source = readFileSync(new URL('./FieldTicketDrawer.tsx', import.meta.url), 'utf8')

test('drafts offer an explicit discard path (F-t04-005)', () => {
  assert.match(
    source,
    /ticket\.status === 'draft' && props\.canManage \? \(\s*<Button[^>]*onClick=\{confirmDiscard\}/,
    'a Discard action must render for manageable drafts',
  )
  assert.match(
    source,
    /method: 'DELETE'/,
    'discarding must call the ticket DELETE endpoint',
  )
})

test('closing a pristine draft discards the shell (F-t04-005)', () => {
  assert.match(
    source,
    /beforeClose=\{async \(\) => \{/,
    'the drawer must guard close with a discard check',
  )
  const guard = source.slice(
    source.indexOf('beforeClose={async () => {'),
    source.indexOf('beforeClose={async () => {') + 500,
  )
  assert.match(
    guard,
    /!headerDirty && !gridDirty/,
    'only a pristine close may discard — edited drafts stay',
  )
  assert.match(
    guard,
    /await discardDraft\(false\)/,
    'a pristine close must discard the empty shell',
  )
})

test('a refused discard pins as an alert (F-t04-005)', () => {
  assert.match(
    source,
    /setDiscardError\(message\)/,
    'a refused explicit discard must pin the typed reason',
  )
  assert.match(
    source,
    /role="alert"/,
    'the drawer must render a role=alert region for the pinned reason',
  )
})

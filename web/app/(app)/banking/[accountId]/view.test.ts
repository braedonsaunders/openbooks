import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// F-t05-006: the account page KPI read posted-only lines while the overview
// roster, the cash table, and gl-summary all read posted+reversed. A
// reversed original counts alongside its posted mirror (the pair nets to
// zero); posted-only keeps the mirror and drops the original, so RBC 1000
// read CA$1,066,531.92 on the page vs -CA$74,017.77 everywhere else
// (gap = the reversed legs, to the cent).
const source = readFileSync(new URL('./view.ts', import.meta.url), 'utf8')

test('account balance follows the house posted-ledger definition', () => {
  assert.match(
    source,
    /join journal_entries je on je\.id = jl\.entry_id and je\.org_id = jl\.org_id and je\.status in \('posted', 'reversed'\)/,
    'KPI balance must include reversed lines like every other surface',
  )
})

test('no posted-only balance remains on the account page', () => {
  assert.doesNotMatch(
    source,
    /je\.status = 'posted'/,
    'a posted-only predicate double-counts live reversal mirrors',
  )
})

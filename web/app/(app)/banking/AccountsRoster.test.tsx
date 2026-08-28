import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const rosterSource = readFileSync(new URL('./AccountsRoster.tsx', import.meta.url), 'utf8')
const homeSource = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')

function daysSince(iso: string | null, now: string): number | null {
  if (!iso) return null
  const then = new Date(`${iso}T00:00:00Z`).getTime()
  const asOf = new Date(`${now}T00:00:00Z`).getTime()
  if (Number.isNaN(then) || Number.isNaN(asOf)) return null
  return Math.max(0, Math.floor((asOf - then) / 86_400_000))
}

function staleStatement(account: { lastStatementDate: string | null; lastImportedAt: string | null }, now: string): boolean {
  const age = daysSince(account.lastStatementDate, now)
  return account.lastStatementDate !== null && age !== null && age > 30
}

test('roster staleness is based on statement coverage, not import recency', () => {
  assert.match(rosterSource, /const statementAge = daysSince\(a\.lastStatementDate\)/)
  assert.doesNotMatch(rosterSource, /const statementAge = daysSince\(a\.lastImportedAt\)/)
})

test('banking home attention uses the same statement coverage date as the roster', () => {
  assert.match(homeSource, /const age = daysSince\(a\.lastStatementDate\)/)
  assert.doesNotMatch(homeSource, /const age = daysSince\(a\.lastImportedAt\)/)
})

test('recent imports do not hide old coverage, while current coverage stays fresh', () => {
  const today = '2026-08-28'
  const recentImport = '2026-08-27T18:00:00.000Z'
  const oldImport = '2026-07-27T18:00:00.000Z'
  const oldCoverage = '2026-07-27'
  const currentCoverage = '2026-08-28'

  // The import timestamp is intentionally recent but must not affect the
  // statement-staleness decision; only the coverage/end date is authoritative.
  assert.equal(staleStatement({ lastStatementDate: oldCoverage, lastImportedAt: recentImport }, today), true)
  assert.equal(staleStatement({ lastStatementDate: currentCoverage, lastImportedAt: oldImport }, today), false)
  assert.equal(daysSince(oldCoverage, today), 32)
  assert.equal(daysSince(currentCoverage, today), 0)
})

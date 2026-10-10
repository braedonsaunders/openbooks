import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveCutoverSteps } from './cutover-steps.ts'
import type { JourneyFacts } from './journey-model.ts'
import { emptyMigrationPlan, type MigrationPlan } from './plan-model.ts'

function facts(plan: Partial<MigrationPlan>, overrides: Partial<JourneyFacts> = {}): JourneyFacts {
  return {
    plan: { ...emptyMigrationPlan(), ...plan },
    sourceName: null,
    bookStart: 'migrate',
    profileReady: true,
    foundationReady: true,
    counts: { accounts: 80, postedEntries: 0, bankAccounts: 1, parties: 0, items: 0 },
    connection: null,
    connections: [],
    runs: { preflight: null, migration: null, mirror: null },
    imports: [],
    openingJournal: null,
    ...overrides,
  }
}

test('a plan without a path starts with planning and nothing else', () => {
  const steps = deriveCutoverSteps(facts({}))
  assert.deepEqual(steps.map((step) => step.key), ['plan'])
  assert.equal(steps[0]!.state, 'current')
})

test('a spreadsheet cutover works its steps in any order without gating', () => {
  const steps = deriveCutoverSteps(facts({ path: 'spreadsheet', sourceSystem: 'spreadsheet', cutoverDate: '2026-11-01' }))
  const state = Object.fromEntries(steps.map((step) => [step.key, step.state]))
  assert.equal(state.plan, 'complete')
  assert.equal(state.cutoverDate, 'complete')
  // Nothing is forced: every remaining step stays reachable, none is blocked.
  for (const key of ['opening', 'receivables', 'payables', 'assets', 'bank', 'checks']) {
    assert.ok(state[key] === 'current' || state[key] === 'upcoming', `${key} stays workable`)
  }
  const href = Object.fromEntries(steps.map((step) => [step.key, step.href]))
  assert.equal(href.opening, '/data/import')
  assert.equal(href.receivables, '/data/import')
  assert.equal(href.bank, '/banking')
})

test('a committed import is progress, only a passing tie check proves the side', () => {
  const imported = facts(
    { path: 'spreadsheet', sourceSystem: 'spreadsheet', cutoverDate: '2026-11-01' },
    { imports: [{ resource: 'txn:customer_invoice', label: 'customer invoices', committedJobs: 1, created: 12, updated: 0, lastAt: '2026-10-01T00:00:00Z' }] },
  )
  const before = Object.fromEntries(deriveCutoverSteps(imported).map((step) => [step.key, step.state]))
  assert.equal(before.receivables, 'current', 'an unmeasured import is not proof')
  const proven = deriveCutoverSteps(imported, [
    { key: 'receivablesTie', state: 'pass', required: true, href: '/reports/aging', facts: {} },
    { key: 'payablesTie', state: 'fail', required: true, href: '/reports/aging', facts: {} },
  ])
  const after = Object.fromEntries(proven.map((step) => [step.key, step.state]))
  assert.equal(after.receivables, 'complete')
  assert.equal(after.payables, 'upcoming', 'no bills imported and no passing check')
})

test('a posted opening journal completes the opening step and points at the draft', () => {
  const posted = facts(
    { path: 'spreadsheet', sourceSystem: 'spreadsheet', cutoverDate: '2026-11-01' },
    { openingJournal: { id: '0192a0b0-0000-7000-8000-000000000002', status: 'posted', documentNumber: 'J-1', documentDate: '2026-10-31' } },
  )
  const steps = deriveCutoverSteps(posted)
  const opening = steps.find((step) => step.key === 'opening')!
  assert.equal(opening.state, 'complete')
  assert.match(opening.href, /\/journal\?journalTab=drafts&entry=/)
  const bank = steps.find((step) => step.key === 'bank')!
  assert.equal(bank.state, 'complete', 'posted balances over existing bank accounts finish the bank step')
})

test('a fresh start needs no opening work', () => {
  const steps = deriveCutoverSteps(facts({ path: 'fresh', cutoverDate: '2026-11-01' }))
  assert.deepEqual(steps.map((step) => step.key), ['plan', 'cutoverDate', 'checks'])
})

test('a connector path loads on the sync page and returns here for the checks', () => {
  const steps = deriveCutoverSteps(facts({ path: 'cutover', sourceSystem: 'example', cutoverDate: '2026-11-01' }))
  const href = Object.fromEntries(steps.map((step) => [step.key, step.href]))
  assert.equal(href.opening, '/sync')
  assert.equal(href.receivables, '/sync')
  assert.equal(href.checks, '/migrate')
})

test('go-live completes the checklist', () => {
  const steps = deriveCutoverSteps(facts({
    path: 'spreadsheet',
    sourceSystem: 'spreadsheet',
    cutoverDate: '2026-11-01',
    goLive: { at: '2026-11-01T00:00:00Z', by: 'u', cutoverDate: '2026-11-01', path: 'spreadsheet', checks: [] },
  }))
  assert.equal(steps.find((step) => step.key === 'checks')!.state, 'complete')
})

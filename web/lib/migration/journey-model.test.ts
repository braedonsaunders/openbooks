import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveCutoverChecks, deriveJourney, type JourneyFacts, type LedgerMeasures, type RunSummary } from './journey-model.ts'
import { applyMigrationPlanChange, emptyMigrationPlan, goLiveBlockers, normalizeMigrationPlan, type MigrationPlan } from './plan-model.ts'

const CONNECTION_ID = '0192a0b0-0000-7000-8000-000000000001'

function run(kind: RunSummary['kind'], status: RunSummary['status'], extra: Partial<RunSummary> = {}): RunSummary {
  return {
    id: `${kind}-run`, kind, status, startedAt: '2026-09-01T10:00:00Z', finishedAt: status === 'running' ? null : '2026-09-01T11:00:00Z',
    syncedThrough: '2026-09-01T11:00:00Z', error: null, tbAccounts: 120, tbMatches: 120, openItemsChecked: 40, openItemsMatches: 40, ...extra,
  }
}

function facts(plan: Partial<MigrationPlan>, overrides: Partial<JourneyFacts> = {}): JourneyFacts {
  return {
    plan: { ...emptyMigrationPlan(), ...plan },
    sourceName: null,
    bookStart: 'migrate',
    profileReady: true,
    foundationReady: true,
    counts: { accounts: 80, postedEntries: 0, bankAccounts: 2, parties: 0, items: 0 },
    connection: null,
    connections: [],
    runs: { preflight: null, migration: null, mirror: null },
    imports: [],
    openingJournal: null,
    ...overrides,
  }
}

const connection = (mirrorEnabled: boolean): JourneyFacts['connection'] => ({
  id: CONNECTION_ID, source: 'example', displayName: 'Example ledger', status: 'active', mirrorEnabled, mirrorSchedule: 'daily', lastRunAt: null, lastError: null,
})

const measured = (overrides: Partial<LedgerMeasures> = {}): LedgerMeasures => ({
  receivablesResidual: '0.0000', payablesResidual: '0.0000', clearingBalance: '0.0000',
  unlockedPrecutoverPeriods: 0, precutoverPeriods: 12, unavailable: {}, ...overrides,
})

test('a stored plan with malformed values reads as unset, never as another choice', () => {
  const plan = normalizeMigrationPlan({ path: 'teleport', cutoverDate: '2026-02-30', connectionId: 'not-a-uuid', sourceSystem: 'Net Suite', goLive: { at: 'x' } })
  assert.equal(plan.path, null)
  assert.equal(plan.cutoverDate, null)
  assert.equal(plan.connectionId, null)
  assert.equal(plan.sourceSystem, null)
  assert.equal(plan.goLive, null)
})

test('go-live freezes the path and cutover date it was measured against', () => {
  const live = { ...emptyMigrationPlan(), path: 'cutover' as const, cutoverDate: '2026-10-01', goLive: { at: '2026-10-02T00:00:00Z', by: 'u', cutoverDate: '2026-10-01', path: 'cutover' as const, checks: [] } }
  assert.equal(applyMigrationPlanChange(live, { cutoverDate: '2026-11-01' }).ok, false)
  assert.equal(applyMigrationPlanChange(live, { path: 'mirror' }).ok, false)
  const notes = applyMigrationPlanChange(live, { notes: 'Archive the old system read-only' })
  assert.ok(notes.ok && notes.changed.join() === 'notes')
})

test('a connector cutover advances one stage at a time from measured runs', () => {
  const plan = { path: 'cutover' as const, sourceSystem: 'example', connectionId: CONNECTION_ID }
  const stagesAt = (f: JourneyFacts) => Object.fromEntries(deriveJourney(f).map((stage) => [stage.key, stage.state]))
  assert.equal(stagesAt(facts(plan)).source, 'current')
  assert.equal(stagesAt(facts(plan, { connection: connection(false) })).rehearse, 'current')
  const loading = stagesAt(facts(plan, { connection: connection(false), runs: { preflight: run('full_preflight', 'ok'), migration: run('full_migration', 'running'), mirror: null } }))
  assert.equal(loading.load, 'current')
  assert.equal(loading.verify, 'upcoming')
  const failed = stagesAt(facts(plan, { connection: connection(false), runs: { preflight: run('full_preflight', 'ok'), migration: run('full_migration', 'ok_with_errors'), mirror: null } }))
  assert.equal(failed.verify, 'current', 'a run that did not verify exactly leaves verification open')
})

test('cutover checks require a verified run through the cutover date and a stopped mirror', () => {
  const plan = { path: 'cutover' as const, sourceSystem: 'example', connectionId: CONNECTION_ID, cutoverDate: '2026-09-15' }
  const runs = { preflight: null, migration: run('full_migration', 'ok'), mirror: run('incremental', 'ok', { finishedAt: '2026-09-16T02:00:00Z', syncedThrough: '2026-09-16T01:00:00Z' }) }
  const mirroring = deriveCutoverChecks(facts(plan, { connection: connection(true), runs }), measured())
  assert.deepEqual(goLiveBlockers(mirroring).map((check) => check.key), ['mirrorStopped'])
  const stopped = deriveCutoverChecks(facts(plan, { connection: connection(false), runs }), measured())
  assert.deepEqual(goLiveBlockers(stopped), [])
  const early = deriveCutoverChecks(facts(plan, { connection: connection(false), runs: { ...runs, mirror: run('incremental', 'ok', { syncedThrough: '2026-09-10T00:00:00Z', finishedAt: '2026-09-17T00:00:00Z' }) } }), measured())
  assert.deepEqual(goLiveBlockers(early).map((check) => check.key), ['syncedThroughCutover'])
})

test('spreadsheet go-live requires the posted opening journal, a zero clearing account and tied subledgers', () => {
  const plan = { path: 'spreadsheet' as const, sourceSystem: 'spreadsheet', cutoverDate: '2026-10-01', openingBalanceAccountId: '0192a0b0-0000-7000-8000-0000000000aa' }
  const draft = { id: 'j1', status: 'draft', documentNumber: 'JE-1', documentDate: '2026-09-30' }
  const blocked = deriveCutoverChecks(facts(plan, { openingJournal: draft }), measured({ clearingBalance: '125.0000', receivablesResidual: null, unavailable: { receivables: 'missing exchange rates' } }))
  assert.deepEqual(goLiveBlockers(blocked).map((check) => check.key).sort(), ['openingClearingZero', 'openingJournalPosted', 'receivablesTie'])
  const clean = deriveCutoverChecks(facts(plan, { openingJournal: { ...draft, status: 'posted' } }), measured({ unlockedPrecutoverPeriods: 3 }))
  assert.deepEqual(goLiveBlockers(clean), [], 'unlocked periods are reported but advisory')
  assert.equal(clean.find((check) => check.key === 'periodsLocked')?.state, 'fail')
  const wrongDate = deriveCutoverChecks(facts(plan, { openingJournal: { ...draft, status: 'posted', documentDate: '2026-10-01' } }), measured())
  assert.deepEqual(goLiveBlockers(wrongDate).map((check) => check.key), ['openingJournalPosted'])
})

test('a mirror path has no go-live checks: the previous system stays the system of record', () => {
  assert.deepEqual(deriveCutoverChecks(facts({ path: 'mirror', sourceSystem: 'example' }), measured()), [])
})

import { connectSourceHref } from './links'
import { addCalendarDays } from '@openbooks/engine/platform/civil-date'
import {
  isConnectorPath,
  journeyStages,
  requiredCutoverCheckKeys,
  type CutoverCheck,
  type CutoverCheckState,
  type JourneyStage,
  type JourneyStageKey,
  type MigrationPlan,
} from './plan-model'

/**
 * Pure derivation of the migration journey and its cutover checks from
 * measured facts. The server loader gathers the facts; this module decides
 * states, so the rules are testable without a database and the workspace,
 * the assistant and go-live all read one judgement.
 */

export type RunStatus = 'running' | 'ok' | 'ok_with_errors' | 'failed'

export interface RunSummary {
  id: string
  kind: 'full_preflight' | 'full_migration' | 'incremental'
  status: RunStatus
  startedAt: string
  finishedAt: string | null
  /** The source high-water mark the run captured. */
  syncedThrough: string | null
  error: string | null
  tbAccounts: number | null
  tbMatches: number | null
  openItemsChecked: number | null
  openItemsMatches: number | null
}

export interface ConnectionSummary {
  id: string
  source: string
  displayName: string
  status: 'unconfigured' | 'active' | 'paused' | 'error'
  mirrorEnabled: boolean
  mirrorSchedule: string
  lastRunAt: string | null
  lastError: string | null
}

export interface ImportSummary {
  resource: string
  label: string
  committedJobs: number
  created: number
  updated: number
  lastAt: string
}

export interface JourneyFacts {
  plan: MigrationPlan
  /** The previous system's display name: the operator's label, else the connector's name. */
  sourceName: string | null
  bookStart: 'fresh' | 'migrate'
  profileReady: boolean
  foundationReady: boolean
  counts: { accounts: number; postedEntries: number; bankAccounts: number; parties: number; items: number }
  connection: ConnectionSummary | null
  connections: ConnectionSummary[]
  runs: { preflight: RunSummary | null; migration: RunSummary | null; mirror: RunSummary | null }
  imports: ImportSummary[]
  openingJournal: { id: string; status: string; documentNumber: string | null; documentDate: string | null } | null
}

/** Measurements that need ledger reads; absent means not measured yet. */
export interface LedgerMeasures {
  /** Control balance not explained by open documents (aging residual), by side. */
  receivablesResidual: string | null
  payablesResidual: string | null
  /** Ledger balance of the opening-balance clearing account. */
  clearingBalance: string | null
  /** Accounting periods ending before the cutover without a closed org-wide GL lock. */
  unlockedPrecutoverPeriods: number | null
  precutoverPeriods: number | null
  /** Why a measure could not be taken, e.g. missing exchange rates. */
  unavailable: Record<string, string>
}

const MASTER_RESOURCES = new Set(['accounts', 'parties', 'items'])

/** The verified run that last changed the books: the newest finished migration or mirror run. */
export function latestLedgerRun(runs: JourneyFacts['runs']): RunSummary | null {
  const finished = [runs.migration, runs.mirror].filter((run): run is RunSummary => run !== null)
  if (finished.length === 0) return null
  return finished.sort((a, b) => (b.finishedAt ?? b.startedAt).localeCompare(a.finishedAt ?? a.startedAt))[0]!
}

function stageComplete(key: JourneyStageKey, facts: JourneyFacts, checks: readonly CutoverCheck[] | null): boolean {
  const { plan } = facts
  const connector = isConnectorPath(plan.path)
  const ledgerRun = latestLedgerRun(facts.runs)
  switch (key) {
    case 'plan': return plan.path !== null && (plan.path === 'fresh' || plan.sourceSystem !== null)
    case 'foundation': return facts.profileReady && facts.foundationReady
    case 'source':
      return connector
        ? facts.connection !== null && facts.connection.status !== 'unconfigured'
        : facts.imports.some((entry) => MASTER_RESOURCES.has(entry.resource))
    case 'rehearse': return facts.runs.preflight?.status === 'ok' || facts.runs.migration?.status === 'ok'
    case 'load':
      return connector
        ? facts.runs.migration !== null && facts.runs.migration.status !== 'running' && facts.runs.migration.status !== 'failed'
        : facts.openingJournal?.status === 'posted'
    case 'verify':
      if (connector) return ledgerRun?.status === 'ok'
      if (!checks) return plan.goLive !== null
      return ['openingJournalPosted', 'openingClearingZero', 'receivablesTie', 'payablesTie']
        .every((name) => { const check = checks.find((entry) => entry.key === name); return !check || check.state === 'pass' || check.state === 'not_applicable' })
    case 'mirror': return facts.connection?.mirrorEnabled === true && facts.runs.mirror?.status === 'ok'
    case 'cutover': return plan.goLive !== null
    case 'live': return plan.goLive !== null
  }
}

function stageHref(key: JourneyStageKey, facts: JourneyFacts): string {
  switch (key) {
    case 'plan': return '/migrate'
    case 'foundation': return '/admin/setup/readiness'
    case 'source':
      return isConnectorPath(facts.plan.path)
        ? facts.connection ? '/sync' : connectSourceHref(facts.plan.sourceSystem ?? '')
        : '/data/import'
    case 'rehearse':
    case 'load':
      return isConnectorPath(facts.plan.path) ? '/sync' : facts.openingJournal ? `/journal?journalTab=drafts&entry=${facts.openingJournal.id}` : '/data/import'
    case 'verify': return isConnectorPath(facts.plan.path) ? '/sync' : '/reports/aging'
    case 'mirror': return '/sync'
    case 'cutover': return '/migrate'
    case 'live': return '/dashboard'
  }
}

function stageFacts(key: JourneyStageKey, facts: JourneyFacts): JourneyStage['facts'] {
  const ledgerRun = latestLedgerRun(facts.runs)
  switch (key) {
    case 'plan': return { path: facts.plan.path, source: facts.plan.sourceLabel ?? facts.plan.sourceSystem, cutoverDate: facts.plan.cutoverDate }
    case 'foundation': return { accounts: facts.counts.accounts, bankAccounts: facts.counts.bankAccounts, profileReady: facts.profileReady, foundationReady: facts.foundationReady }
    case 'source':
      return isConnectorPath(facts.plan.path)
        ? { connection: facts.connection?.displayName ?? null, status: facts.connection?.status ?? null }
        : { importedResources: facts.imports.length, parties: facts.counts.parties, items: facts.counts.items, accounts: facts.counts.accounts }
    case 'rehearse': return { status: facts.runs.preflight?.status ?? null, finishedAt: facts.runs.preflight?.finishedAt ?? null }
    case 'load':
      return isConnectorPath(facts.plan.path)
        ? { status: facts.runs.migration?.status ?? null, finishedAt: facts.runs.migration?.finishedAt ?? null, postedEntries: facts.counts.postedEntries }
        : { openingJournal: facts.openingJournal?.documentNumber ?? null, openingStatus: facts.openingJournal?.status ?? null }
    case 'verify':
      return {
        status: ledgerRun?.status ?? null,
        tbAccounts: ledgerRun?.tbAccounts ?? null,
        tbMatches: ledgerRun?.tbMatches ?? null,
        openItemsChecked: ledgerRun?.openItemsChecked ?? null,
        openItemsMatches: ledgerRun?.openItemsMatches ?? null,
      }
    case 'mirror': return { enabled: facts.connection?.mirrorEnabled ?? false, schedule: facts.connection?.mirrorSchedule ?? null, lastRunAt: facts.runs.mirror?.finishedAt ?? null, status: facts.runs.mirror?.status ?? null }
    case 'cutover': return { cutoverDate: facts.plan.cutoverDate }
    case 'live': return { liveAt: facts.plan.goLive?.at ?? null, cutoverDate: facts.plan.goLive?.cutoverDate ?? null }
  }
}

export function deriveJourney(facts: JourneyFacts, checks: readonly CutoverCheck[] | null = null): JourneyStage[] {
  let currentAssigned = false
  return journeyStages(facts.plan.path).map((key) => {
    const complete = stageComplete(key, facts, checks)
    const state = complete ? 'complete' : currentAssigned ? 'upcoming' : 'current'
    if (!complete) currentAssigned = true
    return { key, state, href: stageHref(key, facts), facts: stageFacts(key, facts) }
  })
}

function check(key: CutoverCheck['key'], state: CutoverCheckState, required: boolean, href: string, facts: CutoverCheck['facts'] = {}): CutoverCheck {
  return { key, state, required, href, facts }
}

const isZeroText = (value: string | null) => value !== null && /^-?0*(\.0*)?$/.test(value.trim())

/**
 * The final checks before go-live, per path. Required checks gate the
 * go-live command; advisory checks are reported but do not block it.
 */
export function deriveCutoverChecks(facts: JourneyFacts, measures: LedgerMeasures): CutoverCheck[] {
  const { plan } = facts
  if (!plan.path || plan.path === 'mirror') return []
  const connector = plan.path === 'cutover'
  const spreadsheet = plan.path === 'spreadsheet'
  const requiredKeys = new Set(requiredCutoverCheckKeys(plan))
  const checks: CutoverCheck[] = [
    check('foundation', facts.foundationReady && facts.profileReady ? 'pass' : 'fail', true, '/admin/setup/readiness', { foundationReady: facts.foundationReady, profileReady: facts.profileReady }),
    check('cutoverDate', plan.cutoverDate ? 'pass' : 'fail', true, '/migrate', { cutoverDate: plan.cutoverDate }),
  ]
  if (connector) {
    const run = latestLedgerRun(facts.runs)
    const runState: CutoverCheckState = !run || run.status === 'running' ? 'pending' : run.status === 'ok' ? 'pass' : 'fail'
    checks.push(check('sourceVerified', runState, true, '/sync', {
      runId: run?.id ?? null, status: run?.status ?? null, finishedAt: run?.finishedAt ?? null,
      tbAccounts: run?.tbAccounts ?? null, tbMatches: run?.tbMatches ?? null,
      openItemsChecked: run?.openItemsChecked ?? null, openItemsMatches: run?.openItemsMatches ?? null,
      error: run?.error ?? null,
    }))
    const through = run?.syncedThrough?.slice(0, 10) ?? null
    checks.push(check('syncedThroughCutover',
      !plan.cutoverDate || !through ? 'pending' : through >= plan.cutoverDate ? 'pass' : 'fail',
      true, '/sync', { syncedThrough: through, cutoverDate: plan.cutoverDate }))
    const connection = facts.connection
    checks.push(check('mirrorStopped',
      !connection ? 'pending' : !connection.mirrorEnabled || connection.status === 'paused' ? 'pass' : 'fail',
      true, '/sync', { mirrorEnabled: connection?.mirrorEnabled ?? null, status: connection?.status ?? null }))
  }
  if (spreadsheet) {
    const journal = facts.openingJournal
    checks.push(check('openingJournalPosted', !journal ? 'pending' : journal.status === 'posted' && plan.cutoverDate && journal.documentDate === addCalendarDays(plan.cutoverDate, -1) ? 'pass' : 'fail', true,
      journal ? `/journal?journalTab=drafts&entry=${journal.id}` : '/migrate',
      { documentNumber: journal?.documentNumber ?? null, status: journal?.status ?? null, documentDate: journal?.documentDate ?? null, cutoverDate: plan.cutoverDate }))
    if (plan.openingBalanceAccountId) {
      checks.push(check('openingClearingZero',
        measures.clearingBalance === null ? 'pending' : isZeroText(measures.clearingBalance) ? 'pass' : 'fail',
        true, '/accounts', { balance: measures.clearingBalance, reason: measures.unavailable.clearing ?? null }))
    } else {
      checks.push(check('openingClearingZero', 'not_applicable', false, '/migrate'))
    }
  }
  if (plan.path !== 'fresh') {
    for (const [key, residual, unavailable] of [
      ['receivablesTie', measures.receivablesResidual, measures.unavailable.receivables],
      ['payablesTie', measures.payablesResidual, measures.unavailable.payables],
    ] as const) {
      checks.push(check(key, residual === null ? 'pending' : isZeroText(residual) ? 'pass' : 'fail', spreadsheet, '/reports/aging',
        { residual, reason: unavailable ?? null }))
    }
  }
  if (plan.cutoverDate && plan.path !== 'fresh') {
    const unlocked = measures.unlockedPrecutoverPeriods
    checks.push(check('periodsLocked', unlocked === null ? 'pending' : unlocked === 0 ? 'pass' : 'fail', false, '/close',
      { unlocked, periods: measures.precutoverPeriods }))
  }
  return checks.map((entry) => ({ ...entry, required: requiredKeys.has(entry.key) }))
}

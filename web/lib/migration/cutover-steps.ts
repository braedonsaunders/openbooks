import { isConnectorPath, type CutoverCheck } from './plan-model'
import type { JourneyFacts } from './journey-model'

/**
 * The guided cutover checklist: one skippable, resumable step per body of
 * migration work, derived from the same measured facts the assistant and
 * the final checks read. Steps never gate each other — an operator works
 * them in any order and skips what does not apply; only the go-live
 * command enforces its required checks. Pure, so the rules are testable
 * without a database.
 */

export const CUTOVER_STEP_KEYS = [
  'plan',
  'cutoverDate',
  'opening',
  'receivables',
  'payables',
  'assets',
  'bank',
  'checks',
] as const
export type CutoverStepKey = (typeof CUTOVER_STEP_KEYS)[number]

export type CutoverStepState = 'complete' | 'current' | 'upcoming'

export interface CutoverStep {
  key: CutoverStepKey
  state: CutoverStepState
  href: string
}

const AR_RESOURCE = 'txn:customer_invoice'
const AP_RESOURCE = 'txn:vendor_bill'
const ASSETS_RESOURCE = 'fixed-assets'

function committedImport(facts: JourneyFacts, resource: string): boolean {
  return facts.imports.some((entry) => entry.resource === resource && entry.committedJobs > 0)
}

function checkState(checks: readonly CutoverCheck[] | null, key: CutoverCheck['key']): CutoverCheck['state'] | null {
  return checks?.find((entry) => entry.key === key)?.state ?? null
}

/**
 * Whether an open-items side is proven: the tie check passes when measured.
 * A committed import without a measured tie is progress, not proof, so it
 * reads as the current step rather than a completed one.
 */
function sideState(facts: JourneyFacts, checks: readonly CutoverCheck[] | null, key: 'receivablesTie' | 'payablesTie', resource: string): CutoverStepState {
  if (checkState(checks, key) === 'pass') return 'complete'
  if (committedImport(facts, resource)) return 'current'
  return 'upcoming'
}

/**
 * Derive the checklist for the plan's path. A plan without a path starts
 * with the planning step; a fresh start needs no opening work; a connector
 * path does its loading on the sync page and returns here for the checks.
 */
export function deriveCutoverSteps(facts: JourneyFacts, checks: readonly CutoverCheck[] | null = null): CutoverStep[] {
  const { plan } = facts
  const connector = isConnectorPath(plan.path)
  const journal = facts.openingJournal
  const journalPosted = journal?.status === 'posted'
  const bankReady = facts.counts.bankAccounts > 0
  const live = plan.goLive !== null

  const opening: CutoverStepState = journalPosted ? 'complete' : journal ? 'current' : 'upcoming'
  const step = (key: CutoverStepKey, state: CutoverStepState, href: string): CutoverStep => ({ key, state, href })

  if (plan.path === null) {
    return [step('plan', 'current', '/migrate')]
  }
  if (plan.path === 'fresh') {
    return [
      step('plan', 'complete', '/migrate'),
      step('cutoverDate', plan.cutoverDate ? 'complete' : 'current', '/migrate'),
      step('checks', live ? 'complete' : 'current', '/migrate'),
    ]
  }
  if (connector) {
    const verified = facts.runs.migration?.status === 'ok'
    return [
      step('plan', 'complete', '/migrate'),
      step('cutoverDate', plan.cutoverDate ? 'complete' : 'current', '/migrate'),
      step('opening', verified ? 'complete' : 'current', '/sync'),
      step('receivables', sideState(facts, checks, 'receivablesTie', AR_RESOURCE) === 'complete' ? 'complete' : verified ? 'current' : 'upcoming', '/sync'),
      step('payables', sideState(facts, checks, 'payablesTie', AP_RESOURCE) === 'complete' ? 'complete' : verified ? 'current' : 'upcoming', '/sync'),
      step('assets', committedImport(facts, ASSETS_RESOURCE) || verified ? 'complete' : 'current', '/data/import'),
      step('bank', bankReady && verified ? 'complete' : 'current', '/banking'),
      step('checks', live ? 'complete' : 'current', '/migrate'),
    ]
  }
  return [
    step('plan', 'complete', '/migrate'),
    step('cutoverDate', plan.cutoverDate ? 'complete' : 'current', '/migrate'),
    step('opening', opening, journal ? `/journal?journalTab=drafts&entry=${journal.id}` : '/data/import'),
    step('receivables', sideState(facts, checks, 'receivablesTie', AR_RESOURCE), '/data/import'),
    step('payables', sideState(facts, checks, 'payablesTie', AP_RESOURCE), '/data/import'),
    step('assets', committedImport(facts, ASSETS_RESOURCE) ? 'complete' : 'upcoming', '/data/import'),
    step('bank', journalPosted && bankReady ? 'complete' : bankReady ? 'current' : 'upcoming', '/banking'),
    step('checks', live ? 'complete' : 'current', '/migrate'),
  ]
}

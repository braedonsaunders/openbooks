/**
 * The organization's migration plan: which way its books arrive, from which
 * system, and the cutover date that separates the previous system's history
 * from books kept here. Client-safe: the workspace, the assistant tools and
 * the plan writer share this one normalization.
 *
 * The plan records intent and evidence. It never changes posting behavior;
 * period locks, connection mirrors and journals stay governed by their own
 * native commands, and the go-live record captures the verified checks those
 * commands produced.
 */

import { isIsoCalendarDate } from '@openbooks/engine/platform/civil-date'

export const MIGRATION_PLAN_SCHEMA_VERSION = 1

/**
 * - `mirror`: connect the previous system and keep these books synchronized
 *   from it (evaluation, parallel run, or a reporting replica).
 * - `cutover`: migrate history through a connector, verify it, then stop the
 *   mirror and keep the books here from the cutover date.
 * - `spreadsheet`: bring master data, open items and opening balances from
 *   files, then go live on the cutover date.
 * - `fresh`: start with no prior history.
 */
export const MIGRATION_PATHS = ['mirror', 'cutover', 'spreadsheet', 'fresh'] as const
export type MigrationPath = (typeof MIGRATION_PATHS)[number]

/** A source that is not a connector: files exported from any other system. */
export const SPREADSHEET_SOURCE = 'spreadsheet'
export const OTHER_SOURCE = 'other'

export const MAX_PLAN_NOTES = 4_000
export const MAX_SOURCE_LABEL = 120

export interface MigrationGoLive {
  at: string
  by: string
  cutoverDate: string
  path: MigrationPath
  /** The measured checks at the moment of go-live. */
  checks: { key: string; state: CutoverCheckState }[]
}

export interface MigrationPlan {
  schemaVersion: typeof MIGRATION_PLAN_SCHEMA_VERSION
  path: MigrationPath | null
  /** A connector source key, `spreadsheet`, or `other`. */
  sourceSystem: string | null
  /** The operator's name for an `other` or spreadsheet source, e.g. a product name. */
  sourceLabel: string | null
  connectionId: string | null
  /** First day whose transactions are kept in these books rather than the previous system. */
  cutoverDate: string | null
  /** Clearing account that opening open items and the opening trial balance both use. */
  openingBalanceAccountId: string | null
  /** The draft or posted opening-balance journal created by the migration command. */
  openingJournalId: string | null
  /** Scope decisions agreed during planning (history depth, exclusions, owners). */
  notes: string | null
  goLive: MigrationGoLive | null
  updatedAt: string | null
  updatedBy: string | null
}

export const CUTOVER_CHECK_STATES = ['pass', 'fail', 'pending', 'not_applicable'] as const
export type CutoverCheckState = (typeof CUTOVER_CHECK_STATES)[number]

export const CUTOVER_CHECK_KEYS = [
  'foundation',
  'cutoverDate',
  'sourceVerified',
  'syncedThroughCutover',
  'mirrorStopped',
  'openingJournalPosted',
  'openingClearingZero',
  'receivablesTie',
  'payablesTie',
  'periodsLocked',
] as const
export type CutoverCheckKey = (typeof CUTOVER_CHECK_KEYS)[number]

export interface CutoverCheck {
  key: CutoverCheckKey
  state: CutoverCheckState
  /** Required for go-live on this path; advisory checks never block it. */
  required: boolean
  /** Measured values behind the state; never fabricated when unmeasured. */
  facts: Record<string, string | number | boolean | null>
  href: string
}

export const JOURNEY_STAGE_KEYS = ['plan', 'foundation', 'source', 'rehearse', 'load', 'verify', 'mirror', 'cutover', 'live'] as const
export type JourneyStageKey = (typeof JOURNEY_STAGE_KEYS)[number]
export type JourneyStageState = 'complete' | 'current' | 'upcoming'

export interface JourneyStage {
  key: JourneyStageKey
  state: JourneyStageState
  href: string
  facts: Record<string, string | number | boolean | null>
}

/** Stage order per path. A plan without a path has only the planning stage. */
export function journeyStages(path: MigrationPath | null): JourneyStageKey[] {
  switch (path) {
    case 'mirror': return ['plan', 'foundation', 'source', 'rehearse', 'load', 'verify', 'mirror']
    case 'cutover': return ['plan', 'foundation', 'source', 'rehearse', 'load', 'verify', 'cutover', 'live']
    case 'spreadsheet': return ['plan', 'foundation', 'source', 'load', 'verify', 'cutover', 'live']
    case 'fresh': return ['plan', 'foundation', 'live']
    default: return ['plan']
  }
}

export function isConnectorPath(path: MigrationPath | null): boolean {
  return path === 'mirror' || path === 'cutover'
}

/** Required evidence cannot be omitted or downgraded by a check producer. */
export function requiredCutoverCheckKeys(plan: MigrationPlan): CutoverCheckKey[] {
  if (!plan.path || plan.path === 'mirror') return []
  const keys: CutoverCheckKey[] = ['foundation', 'cutoverDate']
  if (plan.path === 'cutover') keys.push('sourceVerified', 'syncedThroughCutover', 'mirrorStopped')
  if (plan.path === 'spreadsheet') {
    keys.push('openingJournalPosted', 'receivablesTie', 'payablesTie')
    if (plan.openingBalanceAccountId) keys.push('openingClearingZero')
  }
  return keys
}

export function emptyMigrationPlan(): MigrationPlan {
  return {
    schemaVersion: MIGRATION_PLAN_SCHEMA_VERSION,
    path: null,
    sourceSystem: null,
    sourceLabel: null,
    connectionId: null,
    cutoverDate: null,
    openingBalanceAccountId: null,
    openingJournalId: null,
    notes: null,
    goLive: null,
    updatedAt: null,
    updatedBy: null,
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SOURCE_KEY = /^[a-z][a-z0-9_-]{0,39}$/

/** A real YYYY-MM-DD calendar date (years 0001–9999), via the shared civil-date validator. */
export function isCalendarDate(value: unknown): value is string {
  return isIsoCalendarDate(value)
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, max) : null
}

function uuid(value: unknown): string | null {
  return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null
}

function goLiveRecord(value: unknown): MigrationGoLive | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const path = MIGRATION_PATHS.find((candidate) => candidate === record.path)
  if (typeof record.at !== 'string' || typeof record.by !== 'string' || !isCalendarDate(record.cutoverDate) || !path) return null
  const checks = Array.isArray(record.checks)
    ? record.checks.flatMap((entry) => {
      if (entry === null || typeof entry !== 'object') return []
      const { key, state } = entry as { key?: unknown; state?: unknown }
      const knownState = CUTOVER_CHECK_STATES.find((candidate) => candidate === state)
      return typeof key === 'string' && knownState ? [{ key, state: knownState }] : []
    })
    : []
  return { at: record.at, by: record.by, cutoverDate: record.cutoverDate, path, checks }
}

/**
 * Read a stored plan defensively. Unknown or malformed values read as unset
 * rather than as a different choice, so a damaged record can never claim a
 * path, a connection or a cutover the operator did not record.
 */
export function normalizeMigrationPlan(raw: unknown): MigrationPlan {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return emptyMigrationPlan()
  const record = raw as Record<string, unknown>
  const sourceSystem = typeof record.sourceSystem === 'string' && SOURCE_KEY.test(record.sourceSystem) ? record.sourceSystem : null
  return {
    schemaVersion: MIGRATION_PLAN_SCHEMA_VERSION,
    path: MIGRATION_PATHS.find((candidate) => candidate === record.path) ?? null,
    sourceSystem,
    sourceLabel: text(record.sourceLabel, MAX_SOURCE_LABEL),
    connectionId: uuid(record.connectionId),
    cutoverDate: isCalendarDate(record.cutoverDate) ? record.cutoverDate : null,
    openingBalanceAccountId: uuid(record.openingBalanceAccountId),
    openingJournalId: uuid(record.openingJournalId),
    notes: text(record.notes, MAX_PLAN_NOTES),
    goLive: goLiveRecord(record.goLive),
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : null,
    updatedBy: uuid(record.updatedBy),
  }
}

/** The operator-editable fields. Go-live and the opening journal have their own commands. */
export interface MigrationPlanChange {
  path?: MigrationPath | null
  sourceSystem?: string | null
  sourceLabel?: string | null
  connectionId?: string | null
  cutoverDate?: string | null
  openingBalanceAccountId?: string | null
  notes?: string | null
}

export type PlanChangeResult =
  | { ok: true; plan: MigrationPlan; changed: (keyof MigrationPlanChange)[] }
  | { ok: false; field: keyof MigrationPlanChange | 'goLive'; reason: string }

/**
 * Apply an operator change to a plan. Pure: reference existence (connection,
 * account) is checked by the server writer against the organization, after
 * this shape validation. A recorded go-live freezes the path and the cutover
 * date, because the go-live evidence was measured against them.
 */
export function applyMigrationPlanChange(current: MigrationPlan, change: MigrationPlanChange): PlanChangeResult {
  const next: MigrationPlan = { ...current }
  const changed: (keyof MigrationPlanChange)[] = []
  if (change.path !== undefined) {
    if (change.path !== null && !MIGRATION_PATHS.includes(change.path)) return { ok: false, field: 'path', reason: `Choose one of: ${MIGRATION_PATHS.join(', ')}.` }
    if (current.goLive && change.path !== current.path) return { ok: false, field: 'goLive', reason: 'These books are already live; the migration path is part of the recorded go-live evidence.' }
    next.path = change.path
  }
  if (change.sourceSystem !== undefined) {
    if (change.sourceSystem !== null && !SOURCE_KEY.test(change.sourceSystem)) return { ok: false, field: 'sourceSystem', reason: 'Use a connector source key, "spreadsheet" or "other".' }
    next.sourceSystem = change.sourceSystem
  }
  if (change.sourceLabel !== undefined) next.sourceLabel = text(change.sourceLabel, MAX_SOURCE_LABEL)
  if (change.connectionId !== undefined) {
    if (change.connectionId !== null && !UUID.test(change.connectionId)) return { ok: false, field: 'connectionId', reason: 'Use a connection id from the migration connections list.' }
    next.connectionId = change.connectionId === null ? null : change.connectionId.toLowerCase()
  }
  if (change.cutoverDate !== undefined) {
    if (change.cutoverDate !== null && !isCalendarDate(change.cutoverDate)) return { ok: false, field: 'cutoverDate', reason: 'Use a calendar date in YYYY-MM-DD form.' }
    if (current.goLive && change.cutoverDate !== current.cutoverDate) return { ok: false, field: 'goLive', reason: 'These books are already live; the cutover date is part of the recorded go-live evidence.' }
    next.cutoverDate = change.cutoverDate
  }
  if (change.openingBalanceAccountId !== undefined) {
    if (change.openingBalanceAccountId !== null && !UUID.test(change.openingBalanceAccountId)) return { ok: false, field: 'openingBalanceAccountId', reason: 'Use an account id from the chart of accounts.' }
    next.openingBalanceAccountId = change.openingBalanceAccountId === null ? null : change.openingBalanceAccountId.toLowerCase()
  }
  if (change.notes !== undefined) next.notes = text(change.notes, MAX_PLAN_NOTES)
  for (const key of Object.keys(change) as (keyof MigrationPlanChange)[]) {
    if (change[key] !== undefined && current[key] !== next[key]) changed.push(key)
  }
  if (next.path === 'fresh') {
    next.connectionId = null
  }
  return { ok: true, plan: next, changed }
}

/**
 * Whether the measured checks allow go-live: every required check passes.
 * A pending required check (not yet measurable) refuses exactly like a
 * failure, so go-live can never rest on an unmeasured control.
 */
export function goLiveBlockers(checks: readonly CutoverCheck[]): CutoverCheck[] {
  return checks.filter((check) => check.required && check.state !== 'pass')
}

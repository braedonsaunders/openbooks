import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/platform/database'
import { businessToday } from '@openbooks/engine/platform/business-date'
import { decimalSubtract } from '../reports/decimals'
import { SOURCE_TYPES } from '@openbooks/engine/sync'
import { loadReadinessSnapshot } from '../setup/readiness-snapshot'
import { agingByParty, agingDetail, AgingRatesUnavailableError } from '../reports/aging'
import { readMigrationPlan } from './plan'
import {
  deriveCutoverChecks,
  deriveJourney,
  type ConnectionSummary,
  type ImportSummary,
  type JourneyFacts,
  type LedgerMeasures,
  type RunSummary,
} from './journey-model'
import type { CutoverCheck, JourneyStage, MigrationPlan } from './plan-model'

export interface MigrationJourney {
  plan: MigrationPlan
  facts: JourneyFacts
  stages: JourneyStage[]
  /** Present when requested: measuring them reads the ledger and both agings. */
  checks: CutoverCheck[] | null
  measuredAt: string
}

type ConnectionRow = {
  id: string; source: string; display_name: string; status: ConnectionSummary['status']
  mirror_enabled: boolean; mirror_schedule: string; last_run_at: string | null; last_error: string | null
}

async function loadConnections(orgId: string): Promise<ConnectionSummary[]> {
  const rows = (await db.execute<ConnectionRow>(sql`
    select id, source, display_name, status, mirror_enabled, mirror_schedule, last_run_at::text, last_error
      from connections where org_id = ${orgId} order by created_at, id`)).rows
  return rows.map((row) => ({
    id: row.id, source: row.source, displayName: row.display_name, status: row.status,
    mirrorEnabled: row.mirror_enabled, mirrorSchedule: row.mirror_schedule,
    lastRunAt: row.last_run_at, lastError: row.last_error,
  }))
}

/** The plan's connection, or the only plausible one when the plan names none yet. */
function selectConnection(plan: MigrationPlan, connections: ConnectionSummary[]): ConnectionSummary | null {
  if (plan.connectionId) return connections.find((connection) => connection.id === plan.connectionId) ?? null
  const forSource = plan.sourceSystem ? connections.filter((connection) => connection.source === plan.sourceSystem) : connections
  return forSource.length === 1 ? forSource[0]! : null
}

type RunRow = {
  id: string; kind: RunSummary['kind']; status: RunSummary['status']; started_at: string; finished_at: string | null
  synced_through: string | null; error_message: string | null; stats: Record<string, unknown> | null
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

async function loadRuns(orgId: string, connectionId: string): Promise<JourneyFacts['runs']> {
  const rows = (await db.execute<RunRow>(sql`
    select distinct on (kind) id, kind, status, started_at::text, finished_at::text, synced_through::text, error_message, stats
      from sync_runs
     where org_id = ${orgId} and connection_id = ${connectionId} and kind in ('full_preflight', 'full_migration', 'incremental')
     order by kind, started_at desc`)).rows
  const summary = (row: RunRow | undefined): RunSummary | null => {
    if (!row) return null
    const stats = row.stats ?? {}
    const tb = (stats.tb ?? null) as Record<string, unknown> | null
    const open = (stats.openItems ?? null) as Record<string, unknown> | null
    return {
      id: row.id, kind: row.kind, status: row.status, startedAt: row.started_at, finishedAt: row.finished_at,
      syncedThrough: row.synced_through, error: row.error_message,
      tbAccounts: count(tb?.accounts), tbMatches: count(tb?.matches),
      openItemsChecked: count(open?.checked), openItemsMatches: count(open?.matches),
    }
  }
  return {
    preflight: summary(rows.find((row) => row.kind === 'full_preflight')),
    migration: summary(rows.find((row) => row.kind === 'full_migration')),
    mirror: summary(rows.find((row) => row.kind === 'incremental')),
  }
}

async function loadImports(orgId: string): Promise<ImportSummary[]> {
  const rows = (await db.execute<{ resource_key: string; resource_label: string | null; jobs: number; created: number; updated: number; last_at: string }>(sql`
    select resource_key, max(resource_label) as resource_label, count(*)::int as jobs,
           coalesce(sum(created_count), 0)::int as created, coalesce(sum(updated_count), 0)::int as updated, max(created_at)::text as last_at
      from import_jobs where org_id = ${orgId} and status = 'committed'
     group by resource_key order by max(created_at) desc limit 50`)).rows
  return rows.map((row) => ({ resource: row.resource_key, label: row.resource_label ?? row.resource_key, committedJobs: row.jobs, created: row.created, updated: row.updated, lastAt: row.last_at }))
}

export async function loadJourneyFacts(orgId: string): Promise<JourneyFacts> {
  const [plan, snapshot, connections, imports, masterCounts] = await Promise.all([
    readMigrationPlan(orgId),
    loadReadinessSnapshot(orgId),
    loadConnections(orgId),
    loadImports(orgId),
    db.execute<{ parties: number; items: number }>(sql`
      select (select count(*)::int from parties where org_id = ${orgId} and is_active) as parties,
             (select count(*)::int from items where org_id = ${orgId} and is_active) as items`),
  ])
  const connection = selectConnection(plan, connections)
  const runs = connection ? await loadRuns(orgId, connection.id) : { preflight: null, migration: null, mirror: null }
  const opening = plan.openingJournalId
    ? (await db.execute<{ id: string; status: string; document_number: string | null; document_date: string | null }>(sql`
        select id, status, document_number, document_date::text from documents
         where org_id = ${orgId} and id = ${plan.openingJournalId} and kind = 'journal'`)).rows[0] ?? null
    : null
  return {
    plan,
    sourceName: plan.sourceLabel ?? SOURCE_TYPES.find((type) => type.source === plan.sourceSystem)?.displayName ?? connection?.displayName ?? null,
    bookStart: snapshot.bookStart,
    profileReady: snapshot.profileReady,
    foundationReady: snapshot.foundationReady,
    counts: {
      accounts: snapshot.org.accounts,
      postedEntries: snapshot.org.posted_entries,
      bankAccounts: snapshot.org.bank_accounts,
      parties: masterCounts.rows[0]?.parties ?? 0,
      items: masterCounts.rows[0]?.items ?? 0,
    },
    connection,
    connections,
    runs,
    imports,
    openingJournal: opening ? { id: opening.id, status: opening.status, documentNumber: opening.document_number, documentDate: opening.document_date } : null,
  }
}

/** Control balance the open documents do not explain: the aging residual. */
async function controlResidual(side: 'ar' | 'ap', asOf: string, orgId: string): Promise<{ residual: string } | { unavailable: string }> {
  try {
    const [summary, detail] = await Promise.all([agingByParty(side, asOf, undefined, orgId), agingDetail(side, asOf, undefined, orgId)])
    return { residual: decimalSubtract(summary.totals.total, detail.totals.total) }
  } catch (error) {
    if (error instanceof AgingRatesUnavailableError) return { unavailable: `missing exchange rates for ${error.missing.join(', ')} on or before ${error.asOf}` }
    throw error
  }
}

export async function measureLedger(orgId: string, plan: MigrationPlan): Promise<LedgerMeasures> {
  const unavailable: Record<string, string> = {}
  const asOf = await businessToday(orgId)
  const needsTies = plan.path !== null && plan.path !== 'fresh' && plan.path !== 'mirror'
  const [receivables, payables] = needsTies
    ? await Promise.all([controlResidual('ar', asOf, orgId), controlResidual('ap', asOf, orgId)])
    : [null, null]
  if (receivables && 'unavailable' in receivables) unavailable.receivables = receivables.unavailable
  if (payables && 'unavailable' in payables) unavailable.payables = payables.unavailable
  let clearingBalance: string | null = null
  if (plan.openingBalanceAccountId) {
    const row = (await db.execute<{ balance: string }>(sql`
      select coalesce(sum(l.amount), 0)::text as balance
        from journal_lines l
        join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
        join accounting_books b on b.id = e.book_id and b.org_id = e.org_id and b.is_primary
       where l.org_id = ${orgId} and l.account_id = ${plan.openingBalanceAccountId}
         and e.status in ('posted', 'reversed')`)).rows[0]
    clearingBalance = row?.balance ?? null
  }
  let unlockedPrecutoverPeriods: number | null = null
  let precutoverPeriods: number | null = null
  if (plan.cutoverDate) {
    const row = (await db.execute<{ periods: number; unlocked: number }>(sql`
      select count(*)::int as periods,
             count(*) filter (where not exists (
               select 1 from period_locks l
                join accounting_books b on b.id = l.book_id and b.org_id = l.org_id and b.is_primary
               where l.org_id = p.org_id and l.period_id = p.id and l.module = 'gl'
                 and l.subsidiary_id is null and l.state = 'closed'))::int as unlocked
        from accounting_periods p
       where p.org_id = ${orgId} and not p.is_adjustment and p.ends_on < ${plan.cutoverDate}::date`)).rows[0]
    precutoverPeriods = row?.periods ?? 0
    unlockedPrecutoverPeriods = row?.unlocked ?? 0
  }
  return {
    receivablesResidual: receivables && 'residual' in receivables ? receivables.residual : null,
    payablesResidual: payables && 'residual' in payables ? payables.residual : null,
    clearingBalance,
    unlockedPrecutoverPeriods,
    precutoverPeriods,
    unavailable,
  }
}

export async function measureCutoverChecks(orgId: string, facts: JourneyFacts): Promise<CutoverCheck[]> {
  return deriveCutoverChecks(facts, await measureLedger(orgId, facts.plan))
}

export async function loadMigrationJourney(orgId: string, options: { includeChecks?: boolean } = {}): Promise<MigrationJourney> {
  const facts = await loadJourneyFacts(orgId)
  const checks = options.includeChecks ? await measureCutoverChecks(orgId, facts) : null
  return { plan: facts.plan, facts, stages: deriveJourney(facts, checks), checks, measuredAt: new Date().toISOString() }
}

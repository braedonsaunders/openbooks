import 'server-only'

import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import {
  CONTINUOUS_CLOSE_AGENT_KEYS,
  detectorSpecsForAgent,
  type ContinuousCloseAgentKey,
} from '@openbooks/engine/src/agents/continuous-close-config.ts'
import {
  getContinuousClosePolicies,
  isContinuousCloseAgentKey,
  runContinuousCloseAgent,
  type ContinuousClosePolicy,
} from '@openbooks/engine/src/continuous-close/continuous-close.ts'
import {
  normalizeAgentNotificationSettings,
  saveOrgAiAgentSettings,
  type AgentNotificationSettings,
} from '../assistant/ai-config'
import { isFeatureEnabled } from '../features'

/**
 * Agents setup area — the first-party configuration surface for background
 * agent packs (Setup → Agents). Thin adapters only:
 *
 * - pack metadata is derived from the engine registry
 *   (`CONTINUOUS_CLOSE_AGENT_KEYS` + `detectorSpecsForAgent`), so packs b02/b03
 *   register appear here with no per-agent branch;
 * - policy writes reuse `saveOrgAiAgentSettings` (the same command the
 *   provider page's agent drawer calls, audit row included);
 * - run-now reuses `runContinuousCloseAgent` (the same command behind
 *   POST /api/continuous-close/run).
 *
 * Every read is org-scoped inline (`where org_id = ...`); nothing here
 * bypasses tenant scoping. Display copy lives under the `setup.agents`
 * message namespace (`packs.<agentKey>.title/description/reads/proposes`).
 */

export const AGENT_PACK_FEATURE_KEY = 'continuousClose'

/**
 * Curated read permissions per pack (mirrors the continuous-close read gates
 * where one exists; setup-owned data otherwise). Packs the engine registers
 * after this map was last curated fall back to the setup key — configuring
 * packs already requires it, so an uncurated pack stays honestly gated while
 * the contract test below forces curation (copy + permissions) for every
 * registered key.
 */
const AGENT_PACK_READ_PERMISSIONS: Partial<Record<ContinuousCloseAgentKey, string[]>> = {
  accounting: ['banking.read', 'gl.read', 'close.read'],
  finance: ['reports.read', 'budgets.read'],
  collections: ['ar.read'],
  payables: ['ap.read'],
  reconciliation: ['banking.read'],
  hygiene: ['admin.setup.manage'],
  forensics: ['gl.read', 'ap.read', 'ar.read', 'expenses.read'],
  tax: ['gl.read', 'close.read', 'ap.read', 'ar.read', 'expenses.read'],
  payroll: ['payroll.read', 'close.read'],
  projects: ['gl.read', 'projects.read', 'close.read'],
  cash: ['banking.read', 'gl.read', 'close.read'],
}

/** The registry keys as THIS setup lib sees them — one import point so pages
 *  and tests share the exact module instance instead of pinning a duplicate. */
export { CONTINUOUS_CLOSE_AGENT_KEYS } from '@openbooks/engine/src/agents/continuous-close-config.ts'

export interface AgentPackMeta {
  agentKey: ContinuousCloseAgentKey
  featureKey: typeof AGENT_PACK_FEATURE_KEY
  readPermissions: string[]
  detectorKeys: string[]
}

export function agentPackMeta(agentKey: ContinuousCloseAgentKey): AgentPackMeta {
  return {
    agentKey,
    featureKey: AGENT_PACK_FEATURE_KEY,
    readPermissions: AGENT_PACK_READ_PERMISSIONS[agentKey] ?? ['admin.setup.manage'],
    detectorKeys: detectorSpecsForAgent(agentKey).map((spec) => spec.detectorKey),
  }
}

export function agentPackMetas(): AgentPackMeta[] {
  return CONTINUOUS_CLOSE_AGENT_KEYS.map(agentPackMeta)
}

export interface AgentLastRun {
  id: string
  status: 'completed' | 'failed' | 'skipped' | 'running'
  trigger: 'manual' | 'scheduler'
  startedAt: string
  finishedAt: string | null
  /** Wall-clock milliseconds, null while running or when unfinished. */
  durationMs: number | null
  detected: number
  autoResolved: number
}

export interface AgentOverviewRow {
  agentKey: ContinuousCloseAgentKey
  policy: ContinuousClosePolicy
  /** The Continuous Close feature switch — a pack whose module is off cannot be enabled. */
  featureEnabled: boolean
  lastRun: AgentLastRun | null
  openFindings: number
}

type LastRunRow = {
  agent_key: string
  id: string
  status: AgentLastRun['status']
  trigger: AgentLastRun['trigger']
  started_at: string | Date
  finished_at: string | Date | null
  stats: Record<string, unknown> | null
}

const toIso = (value: string | Date): string => new Date(value).toISOString()

function toLastRun(row: LastRunRow): AgentLastRun {
  const startedAt = toIso(row.started_at)
  const finishedAt = row.finished_at ? toIso(row.finished_at) : null
  const stats = row.stats && typeof row.stats === 'object' ? row.stats : {}
  return {
    id: String(row.id),
    status: row.status,
    trigger: row.trigger,
    startedAt,
    finishedAt,
    durationMs:
      finishedAt === null ? null : Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    detected: Number(stats.detected ?? 0),
    autoResolved: Number(stats.autoResolved ?? 0),
  }
}

/**
 * One row per registered pack: its policy (defaults when never configured),
 * the latest run envelope, and the open-finding count. Powers the Agents
 * overview and the per-pack policy header.
 */
export async function getAgentsOverview(orgId: string): Promise<AgentOverviewRow[]> {
  const [policies, runs, counts, featureOn] = await Promise.all([
    getContinuousClosePolicies(orgId),
    db.execute<LastRunRow>(sql`
      select distinct on (agent_key) agent_key, id::text as id, status, trigger,
             started_at, finished_at, stats
        from ai_agent_runs
       where org_id = ${orgId}
       order by agent_key, started_at desc, id desc
    `),
    db.execute<{ agent_key: string; n: number }>(sql`
      select agent_key, count(*)::int as n
        from ai_work_items
       where org_id = ${orgId} and status in ('open', 'in_review')
       group by agent_key
    `),
    isFeatureEnabled(orgId, AGENT_PACK_FEATURE_KEY),
  ])
  const lastRunByKey = new Map(runs.rows.map((row) => [row.agent_key, toLastRun(row)]))
  const openByKey = new Map(counts.rows.map((row) => [row.agent_key, Number(row.n)]))
  return policies.map((policy) => ({
    agentKey: policy.agentKey,
    policy,
    featureEnabled: featureOn,
    lastRun: lastRunByKey.get(policy.agentKey) ?? null,
    openFindings: openByKey.get(policy.agentKey) ?? 0,
  }))
}

export interface AgentRunStats {
  /** Runs started in the trailing 7 days, any trigger, any pack. */
  runs7d: number
  /** Runs finished `failed` in the trailing 7 days. */
  failed7d: number
}

/**
 * Trailing-7-day run counts for the Agents overview KPI strip. One aggregate
 * row, org-scoped like every other read here.
 */
export async function getAgentRunStats(orgId: string): Promise<AgentRunStats> {
  const res = await db.execute<{ runs7d: number; failed7d: number }>(sql`
    select count(*)::int as runs7d,
           count(*) filter (where status = 'failed')::int as failed7d
      from ai_agent_runs
     where org_id = ${orgId} and started_at >= now() - interval '7 days'
  `)
  const row = res.rows[0]
  return { runs7d: Number(row?.runs7d ?? 0), failed7d: Number(row?.failed7d ?? 0) }
}

export interface AgentRunRow extends AgentLastRun {
  agentKey: ContinuousCloseAgentKey
  detectorVersion: string
  errorCode: string | null
}

const MAX_ACTIVITY_ROWS = 200

const ACTIVITY_SORTS = ['started', 'status', 'pack'] as const
export type AgentActivitySort = (typeof ACTIVITY_SORTS)[number]

/** Whitelisted `?status=` values for the Activity page — unknown degrades to unfiltered, never a 404. */
export const AGENT_RUN_STATUSES = ['completed', 'failed', 'skipped', 'running'] as const
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number]

/**
 * Run envelopes across packs — the Activity page read model and its list
 * contract: the `?agent=` filter, the whitelisted `?status=` filter, the
 * `?since=` lookback (a stable day/week key the loader already mapped to an
 * ISO instant, so shared links never rot — the inbox precedent), server
 * `limit`/`offset` paging and a whitelisted `sort`/`dir` order. `total`
 * counts all matching runs; `truncated` says more rows exist past this
 * window (it stays for the JSON API's show-more shape; the page drives the
 * `pagination` block from total).
 */
export async function listAgentRuns(
  orgId: string,
  options: {
    agentKey?: string
    status?: AgentRunStatus
    startedAfter?: string
    limit?: number
    offset?: number
    sort?: AgentActivitySort
    dir?: 'asc' | 'desc'
  } = {},
): Promise<{ runs: AgentRunRow[]; total: number; truncated: boolean }> {
  const limit = Math.min(Math.max(Math.floor(options.limit ?? 50), 1), MAX_ACTIVITY_ROWS)
  const offset = Math.max(Math.floor(options.offset ?? 0), 0)
  const sort: AgentActivitySort = ACTIVITY_SORTS.includes(options.sort as AgentActivitySort)
    ? (options.sort as AgentActivitySort)
    : 'started'
  const dir = options.dir === 'asc' ? 'asc' : 'desc'
  // Sort fragments are whitelisted above — never interpolated from input.
  const order =
    sort === 'pack'
      ? dir === 'asc'
        ? sql`agent_key asc, started_at desc, id desc`
        : sql`agent_key desc, started_at desc, id desc`
      : sort === 'status'
        ? dir === 'asc'
          ? sql`status asc, started_at desc, id desc`
          : sql`status desc, started_at desc, id desc`
        : dir === 'asc'
          ? sql`started_at asc, id asc`
          : sql`started_at desc, id desc`
  const agentFilter =
    options.agentKey && isContinuousCloseAgentKey(options.agentKey)
      ? sql`and agent_key = ${options.agentKey}`
      : sql``
  const statusFilter =
    options.status && (AGENT_RUN_STATUSES as readonly string[]).includes(options.status)
      ? sql`and status = ${options.status}`
      : sql``
  const sinceMs = options.startedAfter ? Date.parse(options.startedAfter) : Number.NaN
  const sinceFilter = Number.isNaN(sinceMs) ? sql`` : sql`and started_at > ${new Date(sinceMs).toISOString()}`
  const [totalRes, runRes] = await Promise.all([
    db.execute<{ n: number }>(sql`
      select count(*)::int as n from ai_agent_runs
       where org_id = ${orgId} ${agentFilter} ${statusFilter} ${sinceFilter}
    `),
    db.execute<LastRunRow & { agent_key: ContinuousCloseAgentKey; detector_version: string; error_code: string | null }>(sql`
      select agent_key, id::text as id, status, trigger, started_at, finished_at,
             stats, detector_version, error_code
        from ai_agent_runs
       where org_id = ${orgId} ${agentFilter} ${statusFilter} ${sinceFilter}
       order by ${order}
       limit ${limit + 1} offset ${offset}
    `),
  ])
  const total = Number(totalRes.rows[0]?.n ?? 0)
  const truncated = runRes.rows.length > limit
  return {
    runs: runRes.rows.slice(0, limit).map((row) => ({
      ...toLastRun(row),
      agentKey: row.agent_key,
      detectorVersion: String(row.detector_version),
      errorCode: row.error_code ? String(row.error_code) : null,
    })),
    total,
    truncated,
  }
}

/**
 * Setup-scoped policy save: the feature fence first (a pack whose module is
 * off cannot be enabled — the Features-page precedent), then the shared
 * `saveOrgAiAgentSettings` command with its audit row. Throws `invalid_agent`
 * for an unknown key, `feature_disabled` when enabling while the module is
 * off; validation failures propagate as the command's own messages.
 */
export async function saveSetupAgentPolicy(
  orgId: string,
  userId: string,
  agentKey: string,
  body: unknown,
): Promise<ContinuousClosePolicy> {
  if (!isContinuousCloseAgentKey(agentKey)) throw new Error('invalid_agent')
  const enabled = Boolean(
    body && typeof body === 'object' && (body as Record<string, unknown>).enabled === true,
  )
  if (enabled && !(await isFeatureEnabled(orgId, AGENT_PACK_FEATURE_KEY))) {
    throw new Error('feature_disabled')
  }
  return saveOrgAiAgentSettings(orgId, userId, { ...((body ?? {}) as Record<string, unknown>), agentKey })
}

/**
 * Setup-scoped run-now over the shared `runContinuousCloseAgent` command.
 * The actor's scope is REQUIRED: a manual scan runs the org-wide detector
 * pack and auto-resolves other entities' findings, so restricted callers are
 * refused by the engine before anything persists — only explicit null
 * (unrestricted manual runs) proceeds.
 */
export function runSetupAgentNow(
  orgId: string,
  userId: string,
  agentKey: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
) {
  if (!isContinuousCloseAgentKey(agentKey)) throw new Error('invalid_agent')
  return runContinuousCloseAgent({ orgId, agentKey, trigger: 'manual', initiatedBy: userId, allowedSubsidiaryIds })
}

export type { AgentNotificationSettings }

/**
 * Stored finding routing for one pack (`null` = findings-only default).
 * Never throws on stored data: a corrupt value degrades to the default
 * rather than 500ing the policy page.
 */
export async function getSetupAgentNotification(
  orgId: string,
  agentKey: string,
): Promise<AgentNotificationSettings | null> {
  if (!isContinuousCloseAgentKey(agentKey)) throw new Error('invalid_agent')
  const row = (
    await db.execute<{ notification_settings: unknown }>(sql`
      select notification_settings from ai_agent_policies
       where org_id = ${orgId} and agent_key = ${agentKey}
    `)
  ).rows[0]
  try {
    return normalizeAgentNotificationSettings(row?.notification_settings ?? undefined) ?? null
  } catch {
    return null
  }
}

export interface AgentNotificationTarget {
  id: string
  name: string
}

/** Roles and active people routable to a pack's findings, org-scoped. */
export async function listAgentNotificationTargets(orgId: string): Promise<{
  roles: AgentNotificationTarget[]
  users: (AgentNotificationTarget & { email: string })[]
  truncatedUsers: boolean
}> {
  const [rolesRes, usersRes] = await Promise.all([
    db.execute<{ id: string; name: string }>(sql`
      select id::text as id, name from app_roles
       where org_id = ${orgId}
       order by name
    `),
    db.execute<{ id: string; name: string; email: string }>(sql`
      select id::text as id, name, email from users
       where org_id = ${orgId} and is_active
       order by name
       limit 201
    `),
  ])
  return {
    roles: rolesRes.rows.map((row) => ({ id: String(row.id), name: String(row.name) })),
    users: usersRes.rows.slice(0, 200).map((row) => ({
      id: String(row.id),
      name: String(row.name),
      email: String(row.email),
    })),
    truncatedUsers: usersRes.rows.length > 200,
  }
}

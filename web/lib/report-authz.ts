import { db } from '@openbooks/engine/src/platform/db.ts'
import { sql } from 'drizzle-orm'
import 'server-only'
import { NextResponse } from 'next/server'
import { customRecordReportCatalog } from './custom-record-report-catalog'
import { REPORT_ENTITY_MAP } from '@openbooks/reports'
import { can, requirePermission, type Authz } from './authz'
import { isFeatureEnabled } from './features'
import { requireFeatureEnabled } from './feature-gates'
import { notFound } from "@/lib/api/responses";

/**
 * The entity gate for every path that can EXECUTE a stored report plan.
 *
 * `reports.read` says "you may use the reporting tools". It does not say which
 * data those tools may reach: the entity catalog marks sensitive entities with
 * their own `requiredPermission` (payroll registers, journals, employee totals
 * all demand `payroll.read`), and the built-in descriptions promise exactly
 * that — "Requires the payroll permission."
 *
 * Optional-module entities also declare a `featureKey`. A Features switch that
 * is off must hide the entity from the catalog and refuse every execution
 * path — listing a payroll or projects plan is itself a disclosure.
 *
 * The promise only holds if EVERY execution path checks both. Running a plan,
 * exporting it to CSV/XLSX/PDF, and drilling into its supporting rows all
 * return the same underlying rows, so all three owe the same gate; a saved view
 * owes it too (see `viewEntityPermission`, the sibling for the views catalog).
 * Enforcing it in one place is what keeps a new report surface from quietly
 * becoming a wage leak — or a leak of a module the org has switched off.
 *
 * Statement definitions carry no entity plan; they are gated by
 * `STATEMENT_KIND_FEATURE` and `statementKindPermission` instead.
 */

export function reportEntityPermission(query: unknown): string | null {
  const entity = (query as { entity?: unknown } | null | undefined)?.entity
  if (typeof entity !== 'string') return null
  return REPORT_ENTITY_MAP[entity]?.requiredPermission ?? null
}

/** Optional-feature key for a query plan's entity, or null when always on. */
export function reportEntityFeatureKey(query: unknown): string | null {
  const entity = (query as { entity?: unknown } | null | undefined)?.entity
  if (typeof entity !== 'string') return null
  return REPORT_ENTITY_MAP[entity]?.featureKey ?? null
}

/** Statement kinds that disappear when their Features switch is off. */
export const STATEMENT_KIND_FEATURE: Partial<Record<string, string>> = {
  'payroll-support': 'payroll',
  'project-profitability': 'projects',
  'project-budget-vs-actual': 'projects',
  'true-cost': 'projects',
  'earned-value': 'projectProgress',
  budget: 'budgets',
  availability: 'warehousing',
  replenishment: 'warehousing',
  'resourcing-utilization': 'resourcing',
  'resourcing-bench': 'resourcing',
  'resourcing-capacity-demand': 'resourcing',
  'resourcing-engagement': 'resourcing',
}

/**
 * The domain grant every seeded statement reads, beyond `reports.read`.
 *
 * `reports.read` opens the reporting tools; it never stands in for the
 * ledger, the subledgers or another module. Financial statements and ledger
 * detail read the general ledger and need `gl.read`; receivable and payable
 * reports need the side's own read grant; operational statements need their
 * module's read grant. One table, consulted by the hub, the statement pages,
 * exports, scheduled runs and drills, so a role without the ledger grant
 * cannot reach the balance sheet through any of them.
 */
const STATEMENT_KIND_PERMISSION: Partial<Record<string, string>> = {
  pnl: 'gl.read',
  'balance-sheet': 'gl.read',
  'cash-flow': 'gl.read',
  'cash-flow-indirect': 'gl.read',
  'trial-balance': 'gl.read',
  'general-ledger': 'gl.read',
  journal: 'gl.read',
  budget: 'budgets.read',
  'payroll-support': 'payroll.read',
  'project-profitability': 'projects.read',
  'project-budget-vs-actual': 'projects.read',
  'earned-value': 'projects.read',
  'true-cost': 'projects.read',
  availability: 'items.read',
  replenishment: 'items.read',
  'resourcing-utilization': 'resourcing.read',
  'resourcing-bench': 'resourcing.read',
  'resourcing-capacity-demand': 'resourcing.read',
  'resourcing-engagement': 'resourcing.read',
}

/** Statement kinds whose grant depends on the receivable/payable side they show. */
const SIDED_STATEMENT_KINDS = new Set(['aging', 'registers', 'partner-statement', 'partners'])

type StatementParams = Record<string, string | string[] | null | undefined> | URLSearchParams | null | undefined

function statementParam(params: StatementParams, key: string): string | null {
  if (!params) return null
  if (params instanceof URLSearchParams) return params.get(key)
  const value = params[key]
  return (Array.isArray(value) ? value[0] : value) ?? null
}

/**
 * The grant a statement kind needs for the given parameters, or null when it
 * needs nothing beyond reports.read. Sided reports follow the same parameter
 * rules as their resolvers: `side=ap` (or partners `kind` other than
 * receivable) reads payables; anything else reads receivables. An unknown
 * kind fails closed with the ledger grant.
 */
export function statementKindPermission(kind: string, params?: StatementParams): string | null {
  if (SIDED_STATEMENT_KINDS.has(kind)) {
    if (kind === 'partners') {
      const raw = statementParam(params, 'kind') ?? statementParam(params, 'side')
      return raw === 'receivable' ? 'ar.read' : 'ap.read'
    }
    return statementParam(params, 'side') === 'ap' ? 'ap.read' : 'ar.read'
  }
  return STATEMENT_KIND_PERMISSION[kind] ?? 'gl.read'
}

/** True for a seeded statement kind this module grants (every statement page). */
export function isStatementKind(kind: string): boolean {
  return Object.hasOwn(STATEMENT_KIND_PERMISSION, kind) || SIDED_STATEMENT_KINDS.has(kind)
}

/** True when `authz` holds the domain grant this statement needs. */
export function canAccessStatement(authz: Authz, kind: string, params?: StatementParams): boolean {
  const permission = statementKindPermission(kind, params)
  return !permission || can(authz, permission)
}

/**
 * Page boundary for a statement page: the same refusal page every other
 * missing grant renders, naming the grant the statement needs.
 */
export async function requireStatementAccess(kind: string, params?: StatementParams): Promise<Authz> {
  const authz = await requirePermission('reports.read')
  const permission = statementKindPermission(kind, params)
  return permission ? requirePermission(permission) : authz
}

/**
 * The domain grant a report drill target reads, or null when the target's
 * own loader decides (custom definitions and views run through the entity
 * gate). Mirrors the statements the drills come from.
 */
export function reportDrillPermission(target: { kind: string; side?: string; orderKind?: string }): string | null {
  switch (target.kind) {
    case 'ledger':
      return 'gl.read'
    case 'aging':
      return target.side === 'ap' ? 'ap.read' : 'ar.read'
    case 'budget':
      return 'budgets.read'
    case 'orders':
      return target.orderKind === 'purchase_order' ? 'ap.read' : 'ar.read'
    case 'time':
      return 'time.read'
    case 'custom':
      return null
    default:
      return 'gl.read'
  }
}

/** 403 for an API path whose statement grant is missing, or null when allowed. */
export function guardStatementAccess(authz: Authz, kind: string, params?: StatementParams): NextResponse | null {
  return canAccessStatement(authz, kind, params)
    ? null
    : NextResponse.json({ error: 'you do not have access to this data' }, { status: 403 })
}

export function reportStatementFeatureKey(kind: string | null | undefined): string | null {
  if (!kind) return null
  return STATEMENT_KIND_FEATURE[kind] ?? null
}

/**
 * Page boundary for a stored plan (custom report, saved view) whose entity
 * belongs to a switched-off feature. A reader who otherwise holds the entity's
 * permission is sent to the shared feature-required explanation rather than a
 * bare 404; every other refusal stays with `canRunReportEntity`, so a reader
 * without the permission learns nothing about the entity's module.
 */
export async function requireReportEntityFeature(authz: Authz, query: unknown): Promise<void> {
  const featureKey = reportEntityFeatureKey(query)
  if (!featureKey) return
  const required = reportEntityPermission(query)
  if (required && !can(authz, required)) return
  await requireFeatureEnabled(authz.user.orgId, featureKey)
}

/** True when `authz` may execute a plan against this entity. */
export async function canRunReportEntity(authz: Authz, query: unknown): Promise<boolean> {
  const entity = (query as { entity?: string } | null)?.entity
  if (!entity) return false
  if (entity.startsWith('custom:')) return Object.hasOwn(await customRecordReportCatalog(authz), entity)
  if (!REPORT_ENTITY_MAP[entity]) return false
  const required = reportEntityPermission(query)
  if (required && !can(authz, required)) return false
  const featureKey = reportEntityFeatureKey(query)
  if (featureKey && !(await isFeatureEnabled(authz.user.orgId, featureKey))) return false
  return true
}

/** True when `authz` may list or run a seeded statement kind with these parameters. */
export async function canRunReportStatement(
  authz: Authz,
  kind: string | null | undefined,
  params?: StatementParams,
): Promise<boolean> {
  if (!kind || !canAccessStatement(authz, kind, params)) return false
  const featureKey = reportStatementFeatureKey(kind)
  if (!featureKey) return true
  return isFeatureEnabled(authz.user.orgId, featureKey)
}

export type ReportDefinitionGateRow = {
  report_type: string | null
  query: unknown
  statement: { kind?: string; params?: Record<string, string> } | null
}

/**
 * Visibility gate for the report-definition READ surfaces (the definitions
 * list and detail endpoints). Statements carry no entity plan — `query` is
 * null by design — so the entity gate would hide every built-in statement;
 * they answer the statement feature gate instead, while query plans answer
 * the entity gate. Any other report_type stays hidden: no reader was ever
 * granted a type the catalog does not name.
 */
export async function canSeeReportDefinition(authz: Authz, def: ReportDefinitionGateRow): Promise<boolean> {
  if (def.report_type === 'statement') return canRunReportStatement(authz, def.statement?.kind, def.statement?.params)
  if (def.report_type === 'query') return canRunReportEntity(authz, def.query)
  return false
}

/**
 * Refuse a plan whose entity is missing or unknown, whose permission the
 * caller does not hold, or whose Features switch is off. Returns null when
 * allowed, so a route reads
 * `const denied = await guardReportEntity(...); if (denied) return denied`.
 *
 * This is the HTTP face of `canRunReportEntity` for entity plans: every
 * export, run, and definition-write path must go through this gate so a
 * missing `requiredPermission` cannot fail open on an unknown entity.
 *
 * A null/undefined query is not a missing entity. Statement definitions
 * store `query=null` on purpose and are gated by `STATEMENT_KIND_FEATURE`
 * / `canRunReportStatement`. The export route passes `def.query` into this
 * function unconditionally; refusing that value 403s every standard
 * CSV/XLSX/PDF download.
 *
 * Permission misses and unknown/missing entities on a query object are
 * 403. A disabled feature is 404 so the module disappears rather than
 * advertising that it exists.
 */
export async function guardReportEntity(authz: Authz, query: unknown): Promise<NextResponse | null> {
  if (query == null) return null
  if (await canRunReportEntity(authz, query)) return null
  const required = reportEntityPermission(query)
  if (required && !can(authz, required)) {
    return NextResponse.json({ error: 'you do not have access to this data' }, { status: 403 })
  }
  const featureKey = reportEntityFeatureKey(query)
  if (featureKey && !(await isFeatureEnabled(authz.user.orgId, featureKey))) {
    return notFound("record")
  }
  return NextResponse.json({ error: 'you do not have access to this data' }, { status: 403 })
}

/** Entity keys this reader must not see — missing permission or feature off. */
export async function hiddenReportEntityKeys(authz: Authz): Promise<string[]> {
  const out: string[] = []
  for (const entity of Object.values(REPORT_ENTITY_MAP)) {
    if (entity.requiredPermission && !can(authz, entity.requiredPermission)) {
      out.push(entity.key)
      continue
    }
    if (entity.featureKey && !(await isFeatureEnabled(authz.user.orgId, entity.featureKey))) {
      out.push(entity.key)
    }
  }
  const custom = await customRecordReportCatalog(authz)
  const stored = await db.execute<{ entity: string }>(sql`select distinct query->>'entity' as entity from report_definitions
    where org_id=${authz.user.orgId} and query->>'entity' like 'custom:%'`)
  out.push(...stored.rows.filter(r => !Object.hasOwn(custom, r.entity)).map(r => r.entity))
  return out
}

/**
 * Statement kinds this reader must not see: the feature is off, or the
 * reader lacks the kind's grant. Sided kinds hide only when neither side is
 * readable; their per-definition visibility is decided with their parameters.
 */
export async function hiddenReportStatementKinds(authz: Authz): Promise<string[]> {
  const out = new Set<string>()
  for (const [kind, featureKey] of Object.entries(STATEMENT_KIND_FEATURE)) {
    if (featureKey && !(await isFeatureEnabled(authz.user.orgId, featureKey))) out.add(kind)
  }
  for (const kind of Object.keys(STATEMENT_KIND_PERMISSION)) {
    if (!canAccessStatement(authz, kind)) out.add(kind)
  }
  for (const kind of SIDED_STATEMENT_KINDS) {
    if (!can(authz, 'ar.read') && !can(authz, 'ap.read')) out.add(kind)
  }
  return [...out]
}

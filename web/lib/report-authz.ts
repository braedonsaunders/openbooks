import { db } from '@openbooks/engine/src/platform/db.ts'
import { sql } from 'drizzle-orm'
import 'server-only'
import { NextResponse } from 'next/server'
import { customRecordReportCatalog } from './custom-record-report-catalog'
import { REPORT_ENTITY_MAP } from '@openbooks/reports'
import { can, type Authz } from './authz'
import { isFeatureEnabled } from './features'

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
 * `STATEMENT_KIND_FEATURE` instead of being refused here.
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
  'project-profitability': 'projects',
  'true-cost': 'projects',
  budget: 'budgets',
}

export function reportStatementFeatureKey(kind: string | null | undefined): string | null {
  if (!kind) return null
  return STATEMENT_KIND_FEATURE[kind] ?? null
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

/** True when `authz` may list or run a seeded statement kind. */
export async function canRunReportStatement(authz: Authz, kind: string | null | undefined): Promise<boolean> {
  const featureKey = reportStatementFeatureKey(kind)
  if (!featureKey) return true
  return isFeatureEnabled(authz.user.orgId, featureKey)
}

export type ReportDefinitionGateRow = {
  report_type: string | null
  query: unknown
  statement: { kind?: string } | null
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
  if (def.report_type === 'statement') return canRunReportStatement(authz, def.statement?.kind)
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
    return NextResponse.json({ error: 'not found' }, { status: 404 })
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

/** Statement kinds this reader must not see because the feature is off. */
export async function hiddenReportStatementKinds(authz: Authz): Promise<string[]> {
  const out: string[] = []
  for (const [kind, featureKey] of Object.entries(STATEMENT_KIND_FEATURE)) {
    if (featureKey && !(await isFeatureEnabled(authz.user.orgId, featureKey))) out.push(kind)
  }
  return out
}

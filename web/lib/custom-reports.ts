import 'server-only'
import { sql } from 'drizzle-orm'
import { db, pool } from '@openbooks/engine/src/db.ts'
import {
  REPORT_ENTITY_MAP,
  runCustomQuery,
  validateCustomQuery,
  type ReportCustomQuery,
  type ReportRule,
  type ReportRuleGroup,
  type ReportRunLabels,
  type ReportRunResult,
} from '@openbooks/reports'
// The office wrapper applies the CSV formula-injection guard; never import the
// raw serializer from @openbooks/reports for user-facing CSV.
import { reportResultToCsv } from '@openbooks/office'
import { reportCsvOptions, reportRunLabels } from './report-labels'
import { resolvePeriod } from './periods'
import { fiscalStartMonth } from './fiscal'
import { ensureReportDefinitions } from '@openbooks/engine/src/ensure-report-definitions.ts'

/**
 * Server helpers for the custom-report studio (list/builder/run/schedule). The
 * financial-statement queries live in ./reports.ts; this file owns the
 * user-authored report_definitions / report_schedules / report_runs surface.
 */

/** Hard ceiling on rows any report may materialise, matching the engine cap. */
export const REPORT_MAX_ROWS = 10_000

/** Ops whose meaning is "a time window on this field" — replaced wholesale
 *  when the viewer picks a period in the report screen's filter bar. */
const TEMPORAL_OPS = new Set([
  'since_today', 'this_week', 'this_month', 'this_year', 'before_now',
  'period_preset', 'gte', 'lte', 'between',
])

/**
 * The date field a report's period filter governs: the first filter leaf with
 * a temporal op on a date-kind column, else the entity's first date column.
 * Lets the native period picker drive ANY saved query report.
 */
export function reportPeriodField(query: ReportCustomQuery): string | null {
  const entity = REPORT_ENTITY_MAP[query.entity]
  if (!entity) return null
  const dateColumns = new Set(
    entity.columns.filter((c) => c.kind === 'date').map((c) => c.key),
  )
  let found: string | null = null
  const walk = (node: ReportRuleGroup | undefined) => {
    for (const r of node?.rules ?? []) {
      if (found) return
      if (r && typeof r === 'object' && Array.isArray((r as ReportRuleGroup).rules)) {
        walk(r as ReportRuleGroup)
      } else {
        const leaf = r as ReportRule
        if (dateColumns.has(leaf.field) && TEMPORAL_OPS.has(leaf.op)) found = leaf.field
      }
    }
  }
  walk(query.filters ?? undefined)
  if (found) return found
  return entity.columns.find((c) => c.kind === 'date')?.key ?? null
}

/**
 * Replace the plan's time window on `field` with explicit [from, to] bounds —
 * the viewer-picked period wins over the stored preset, nothing else changes.
 */
export function applyPeriodOverride(
  query: ReportCustomQuery,
  field: string,
  bounds: { from: string; to: string },
): ReportCustomQuery {
  const strip = (node: ReportRuleGroup): ReportRuleGroup => ({
    ...node,
    rules: (node.rules ?? [])
      .map((r) => {
        if (r && typeof r === 'object' && Array.isArray((r as ReportRuleGroup).rules)) {
          return strip(r as ReportRuleGroup)
        }
        const leaf = r as ReportRule
        return leaf.field === field && TEMPORAL_OPS.has(leaf.op) ? null : leaf
      })
      .filter((r): r is ReportRule | ReportRuleGroup => r !== null),
  })
  const base = query.filters ? strip(query.filters) : { combinator: 'and' as const, rules: [] }
  return {
    ...query,
    filters: {
      combinator: 'and',
      rules: [
        ...(base.rules.length ? [base] : []),
        { field, op: 'gte', value: bounds.from },
        { field, op: 'lte', value: bounds.to },
      ],
    },
  }
}
/** Rows a studio live-preview fetches — small so the builder stays snappy. */
export const REPORT_PREVIEW_ROWS = 200

export type ReportDefinitionRow = {
  id: string
  org_id: string
  kind: 'built_in' | 'custom'
  /** 'query' = entity-query report; 'statement' = seeded standard statement. */
  report_type: 'query' | 'statement'
  slug: string
  name: string
  description: string | null
  /** NULL for statement definitions (which carry their spec in `statement`). */
  query: ReportCustomQuery | null
  /** Statement spec `{ kind, params? }` for report_type='statement', else null. */
  statement: { kind?: string; params?: Record<string, string> } | null
  system: boolean
  layout: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

/**
 * The org's seeded statement definition for a report kind (+ discriminating
 * params like aging's side) — the anchor every statement page's schedule
 * affordance hangs off. Null when the org has no matching definition.
 */
export async function statementDefinitionId(
  orgId: string,
  kind: string,
  match: Record<string, string> = {},
): Promise<string | null> {
  const r = (await db.execute<{ id: string }>(sql`
    select id from report_definitions
     where org_id = ${orgId} and report_type = 'statement'
       and statement->>'kind' = ${kind}
       and coalesce(statement->'params', '{}'::jsonb) @> ${JSON.stringify(match)}::jsonb
     order by (kind = 'built_in') desc, created_at
     limit 1
  `))
  return r.rows[0]?.id ?? null
}

/** Load one definition scoped to the caller's org, or null. */
export async function loadReportDefinition(
  orgId: string,
  id: string,
): Promise<ReportDefinitionRow | null> {
  await ensureReportDefinitions(orgId)
  const r = (await db.execute<ReportDefinitionRow>(sql`
    select id, org_id, kind, report_type, slug, name, description, query, statement, system, layout, created_at, updated_at
      from report_definitions
     where id = ${id} and org_id = ${orgId}
  `))
  return r.rows[0] ?? null
}

/**
 * Merge a schedule's extra filter group onto a definition's plan. Both trees
 * are AND-ed under a fresh root so neither side can weaken the other; the
 * merged tree is re-validated so a bad override fails loudly.
 */
export function mergeReportFilters(
  base: ReportCustomQuery,
  extra: ReportRuleGroup | null | undefined,
): ReportCustomQuery {
  if (!extra || !Array.isArray(extra.rules) || extra.rules.length === 0) return base
  const rules: NonNullable<ReportRuleGroup['rules']> = []
  if (base.filters && Array.isArray(base.filters.rules) && base.filters.rules.length) {
    rules.push(base.filters)
  }
  rules.push(extra)
  return validateCustomQuery({ ...base, filters: { combinator: 'and', rules } })
}

/**
 * Execute a validated plan against the org, using the engine executor over the
 * shared pg pool (a PgQueryable). `maxRows` clamps under the engine's 10k cap.
 * Shaped display strings (headings, group titles, summary labels) come out in
 * the request locale; pass `labels` to override (e.g. a future scheduled
 * pipeline pinning the org default outside a request).
 */
export async function executeReport(
  orgId: string,
  query: ReportCustomQuery,
  maxRows: number = REPORT_MAX_ROWS,
  labels?: ReportRunLabels,
): Promise<ReportRunResult> {
  const resolved = await resolvePeriodPresets(query, orgId)
  return runCustomQuery(pool, resolved, {
    orgId,
    entityMap: REPORT_ENTITY_MAP,
    maxRows: Math.min(maxRows, REPORT_MAX_ROWS),
    fiscalStartMonth: await fiscalStartMonth(),
    labels: labels ?? (await reportRunLabels()),
  })
}

/**
 * Rewrite every `period_preset` filter leaf into concrete `gte`/`lte` bounds
 * using the fiscal-aware period engine (web/lib/periods.ts). This keeps the
 * DB-free @openbooks/reports compiler unaware of fiscal config while giving the
 * studio the SAME ~50 presets as the financial statements — fixing the old
 * calendar-year-only relative-date behaviour. Resolution is done once here so
 * both interactive and scheduled runs share it, scoped to the EXPLICIT org id
 * (never ambient request state — scheduled/internal runs have no session).
 */
async function resolvePeriodPresets(
  query: ReportCustomQuery,
  orgId?: string,
): Promise<ReportCustomQuery> {
  if (!query.filters) return query
  let touched = false

  const walk = async (node: ReportRuleGroup): Promise<ReportRuleGroup> => {
    const rules: (ReportRule | ReportRuleGroup)[] = []
    for (const r of node.rules ?? []) {
      if (r && typeof r === 'object' && Array.isArray((r as ReportRuleGroup).rules)) {
        rules.push(await walk(r as ReportRuleGroup))
        continue
      }
      const leaf = r as ReportRule
      if (leaf.op === 'period_preset') {
        touched = true
        const presetId = typeof leaf.value === 'string' ? leaf.value : String(leaf.value ?? '')
        const period = await resolvePeriod(presetId, { orgId })
        rules.push({
          combinator: 'and',
          rules: [
            { field: leaf.field, op: 'gte', value: period.from },
            { field: leaf.field, op: 'lte', value: period.to },
          ],
        })
      } else {
        rules.push(leaf)
      }
    }
    return { ...node, rules }
  }

  const filters = await walk(query.filters)
  return touched ? { ...query, filters } : query
}

/**
 * Run a saved definition end-to-end and persist a report_runs row: insert a
 * 'running' row, execute, then stamp success (with the CSV + row count) or
 * failure (with the error). Returns the finished run id and result.
 */
export async function recordReportRun(args: {
  orgId: string
  userId: string
  definitionId: string
  query: ReportCustomQuery
  trigger: 'manual' | 'scheduled'
  scheduleId?: string | null
  maxRows?: number
}): Promise<{ runId: string; result: ReportRunResult | null; error: string | null }> {
  const started = new Date().toISOString()
  const inserted = (await db.execute<{ id: string }>(sql`
    insert into report_runs (org_id, definition_id, schedule_id, trigger, status, started_at, created_by)
    values (${args.orgId}, ${args.definitionId}, ${args.scheduleId ?? null}, ${args.trigger},
            'running', ${started}, ${args.userId})
    returning id
  `))
  const runId = inserted.rows[0]!.id

  try {
    const result = await executeReport(args.orgId, args.query, args.maxRows ?? REPORT_MAX_ROWS)
    // The stored CSV artifact bakes the locale of whoever triggered the run.
    const csv = reportResultToCsv(result, await reportCsvOptions())
    await db.execute(sql`
      update report_runs set status = 'succeeded', row_count = ${result.rowCount},
             result_csv = ${csv}, finished_at = now(), updated_at = now()
       where id = ${runId}
    `)
    return { runId, result, error: null }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Report run failed'
    await db.execute(sql`
      update report_runs set status = 'failed', error = ${message},
             finished_at = now(), updated_at = now()
       where id = ${runId}
    `)
    return { runId, result: null, error: message }
  }
}

/** Slugify a report name into a stable per-org slug candidate. */
export function slugifyReportName(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return base || 'report'
}

/**
 * Ensure `slug` is unique within the org, suffixing -2, -3, … on collision.
 * `excludeId` skips the row being updated so a rename to its own slug is a
 * no-op.
 */
export async function uniqueReportSlug(
  orgId: string,
  desired: string,
  excludeId?: string,
): Promise<string> {
  let slug = desired
  for (let n = 2; n < 1000; n++) {
    const clash = (await db.execute(sql`
      select 1 from report_definitions
       where org_id = ${orgId} and slug = ${slug}
         ${excludeId ? sql`and id <> ${excludeId}` : sql``}
       limit 1
    `))
    if (clash.rows.length === 0) return slug
    slug = `${desired}-${n}`
  }
  return `${desired}-${Date.now()}`
}

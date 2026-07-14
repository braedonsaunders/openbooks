import 'server-only'
import { sql } from 'drizzle-orm'
import { db, pool } from '@openbooks/engine/src/db.ts'
import {
  REPORT_ENTITY_MAP,
  reportResultToCsv,
  runCustomQuery,
  validateCustomQuery,
  type ReportCustomQuery,
  type ReportRuleGroup,
  type ReportRunResult,
} from '@openbooks/reports'

/**
 * Server helpers for the custom-report studio (list/builder/run/schedule). The
 * financial-statement queries live in ./reports.ts; this file owns the
 * user-authored report_definitions / report_schedules / report_runs surface.
 */

/** Hard ceiling on rows any report may materialise, matching the engine cap. */
export const REPORT_MAX_ROWS = 10_000
/** Rows a studio live-preview fetches — small so the builder stays snappy. */
export const REPORT_PREVIEW_ROWS = 200

export type ReportDefinitionRow = {
  id: string
  org_id: string
  kind: 'built_in' | 'custom'
  slug: string
  name: string
  description: string | null
  query: ReportCustomQuery
  layout: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

/** Load one definition scoped to the caller's org, or null. */
export async function loadReportDefinition(
  orgId: string,
  id: string,
): Promise<ReportDefinitionRow | null> {
  const r = (await db.execute(sql`
    select id, org_id, kind, slug, name, description, query, layout, created_at, updated_at
      from report_definitions
     where id = ${id} and org_id = ${orgId}
  `)) as unknown as { rows: ReportDefinitionRow[] }
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
 */
export async function executeReport(
  orgId: string,
  query: ReportCustomQuery,
  maxRows: number = REPORT_MAX_ROWS,
): Promise<ReportRunResult> {
  return runCustomQuery(pool, query, {
    orgId,
    entityMap: REPORT_ENTITY_MAP,
    maxRows: Math.min(maxRows, REPORT_MAX_ROWS),
  })
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
  const inserted = (await db.execute(sql`
    insert into report_runs (org_id, definition_id, schedule_id, trigger, status, started_at, created_by)
    values (${args.orgId}, ${args.definitionId}, ${args.scheduleId ?? null}, ${args.trigger},
            'running', ${started}, ${args.userId})
    returning id
  `)) as unknown as { rows: { id: string }[] }
  const runId = inserted.rows[0]!.id

  try {
    const result = await executeReport(args.orgId, args.query, args.maxRows ?? REPORT_MAX_ROWS)
    const csv = reportResultToCsv(result)
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
    `)) as unknown as { rows: unknown[] }
    if (clash.rows.length === 0) return slug
    slug = `${desired}-${n}`
  }
  return `${desired}-${Date.now()}`
}

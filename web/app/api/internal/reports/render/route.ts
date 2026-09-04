import { scheduledReportAuthz, withReportAuthz, type ReportAuthorization } from '../../../../../lib/report-execution-context'
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
import { db, withOrg } from '@openbooks/engine/src/db.ts'
import type { ReportRuleGroup } from '@openbooks/reports'
import { getTranslations } from 'next-intl/server'
import { resolveDefinitionToExportData } from '../../../../../lib/report-run'
import { exportDataToPdf, exportDataToXlsx, orgBranding, resolveLayout, type Translator } from '../../../../../lib/report-pdf'
import { resolvePeriod } from '../../../../../lib/periods'
import { parseReportQuery } from '../../../../../lib/report-filters'

export const runtime = 'nodejs'

/**
 * Internal report render endpoint — the background worker calls this to turn a
 * definition into a PDF (report rendering lives in web/lib; the worker can't
 * import it). Not a user route: authenticated by a shared internal token and
 * given orgId + definitionId explicitly.
 *
 *   GET /api/internal/reports/render?orgId=&definitionId=&<report params>
 */
export async function GET(req: Request) {
  const expected = process.env.OPENBOOKS_INTERNAL_TOKEN || ''
  const provided = req.headers.get('x-internal-token') || ''
  if (!expected || provided !== expected) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const url = new URL(req.url)
  const p = url.searchParams
  const orgId = p.get('orgId')
  const definitionId = p.get('definitionId')
  if (!orgId || !definitionId) {
    return NextResponse.json({ error: 'orgId and definitionId are required' }, { status: 422 })
  }

  // No session on this seam: scope every row-level-secured query to the
  // worker-supplied org explicitly (FORCE RLS otherwise yields zero rows).
  try {
    return await withOrg(orgId, async () => {
    const t = (await getTranslations('reports')) as unknown as Translator
    const runId = p.get('runId')
    if (!runId) return NextResponse.json({ error: 'scheduled runId is required' }, { status: 422 })
    let authorization_snapshot: ReportAuthorization | null = null
    let extraFilters: ReportRuleGroup | null = null
    if (runId) {
      const run = (await db.execute<{ filters: Record<string, unknown> | null; authorization_snapshot: ReportAuthorization | null }>(sql`
        select filters, authorization_snapshot from report_runs
         where id=${runId} and org_id=${orgId} and definition_id=${definitionId} and trigger='scheduled'
      `))
      if (!run.rows[0]) return NextResponse.json({ error: 'scheduled report run not found' }, { status: 404 })
      authorization_snapshot = run.rows[0].authorization_snapshot
      const stored = run.rows[0].filters
      // A schedule's filters carry either a query-report extra rule group
      // (legacy shape: the group itself) or a statement-params snapshot taken
      // from the report screen at scheduling time.
      if (stored && typeof stored === 'object') {
        const statementParams = (stored as { statementParams?: Record<string, string> }).statementParams
        if (statementParams && typeof statementParams === 'object') {
          for (const [key, value] of Object.entries(statementParams)) {
            if (typeof value === 'string' && !p.has(key)) p.set(key, value)
          }
        } else if (Array.isArray((stored as ReportRuleGroup).rules)) {
          extraFilters = stored as unknown as ReportRuleGroup
        }
      }
    }
    // Re-resolve the period AFTER schedule params landed (they may pin one).
    const scheduledQ = parseReportQuery(p)
    const scheduledPeriod = await resolvePeriod(scheduledQ.period, {
      customFrom: p.get('from') ?? undefined,
      customTo: p.get('to') ?? undefined,
      orgId,
    })
    if (!authorization_snapshot) return NextResponse.json({ error: 'report schedule requires reauthorization' }, { status: 403 })
    const authz = await scheduledReportAuthz(orgId, authorization_snapshot)
    if (p.get('authorizeOnly') === '1') return new NextResponse(null, { status: 204 })
    const data = await withReportAuthz(authz, () => resolveDefinitionToExportData(
      orgId,
      definitionId,
      p,
      { orgId, t, period: scheduledPeriod, query: scheduledQ },
      { extraFilters, definition: authorization_snapshot!.definition },
    ))
    const stamp = await businessToday(orgId)
    if (p.get('format') === 'xlsx') {
      const xlsx = await exportDataToXlsx(data, {
        reportName: data.title,
        dateRangeLabel: data.dateRangeLabel,
        generatedAt: new Date(`${stamp}T00:00:00Z`),
      })
      return new NextResponse(new Uint8Array(xlsx), {
        status: 200,
        headers: {
          'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'cache-control': 'no-store',
        },
      })
    }
    const branding = await orgBranding(orgId)
    const { page, showSummary } = resolveLayout(null)
    const pdf = await exportDataToPdf(data, branding, page, {
      showSummary,
      generatedAt: new Date(`${stamp}T00:00:00Z`),
    })
    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: { 'content-type': 'application/pdf', 'cache-control': 'no-store' },
    })
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'render failed'
    // A stored plan survives a Features toggle; a fresh artifact must not.
    // 404 (not 422) so the scheduler treats this as refuse, not a bad plan.
    if (message.endsWith('feature is disabled')) {
      return NextResponse.json({ error: 'not found' }, { status: 404 })
    }
    return NextResponse.json({ error: message }, { status: 422 })
  }
}

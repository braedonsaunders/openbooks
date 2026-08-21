import { NextResponse } from 'next/server'
import { getTranslations } from 'next-intl/server'
import { guardPermission } from '../../../../../../lib/authz'
import { guardReportEntity } from '../../../../../../lib/report-authz'
import { loadReportDefinition } from '../../../../../../lib/custom-reports'
import { resolveDefinitionToExportData } from '../../../../../../lib/report-run'
import { resolvePeriod } from '../../../../../../lib/periods'
import { parseReportQuery } from '../../../../../../lib/report-filters'
import { reportCsvOptions } from '../../../../../../lib/report-labels'
import {
  exportDataToCsv,
  exportDataToPdf,
  exportDataToXlsx,
  orgBranding,
  resolveLayout,
  type Translator,
} from '../../../../../../lib/report-pdf'
import { csvResponse, pdfResponse, safeName, xlsxResponse } from '../../../../../../lib/export'
import { businessToday } from '@openbooks/engine/src/business-date.ts'

export const runtime = 'nodejs'

/**
 * Export a saved report definition to PDF, Excel or CSV. Runs the plan fresh
 * (always-current data) — the recorded-run CSV artifact route stays for the
 * audit trail of a specific past run.
 *
 *   GET /api/reports/definitions/[id]/export?format=pdf|xlsx|csv
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('reports.read')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { id } = await params

  const url = new URL(_req.url)
  const format = (url.searchParams.get('format') ?? 'csv').toLowerCase()
  if (!['pdf', 'xlsx', 'csv'].includes(format)) {
    return NextResponse.json({ error: 'invalid format' }, { status: 422 })
  }

  const def = await loadReportDefinition(user.orgId, id)
  if (!def) return NextResponse.json({ error: 'report not found' }, { status: 404 })

  // An export returns the SAME rows the runner does. `reports.read` alone must
  // not reach a payroll plan through the download button.
  const denied = guardReportEntity(gate, def.query)
  if (denied) return denied

  const t = (await getTranslations('reports')) as unknown as Translator

  // One pipeline for BOTH standard (statement) and custom (query) definitions.
  const q = parseReportQuery(url.searchParams)
  const period = await resolvePeriod(q.period, {
    customFrom: url.searchParams.get('from') ?? undefined,
    customTo: url.searchParams.get('to') ?? undefined,
  })
  let data
  try {
    data = await resolveDefinitionToExportData(user.orgId, id, url.searchParams, { orgId: user.orgId, t, period, query: q })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Report run failed' }, { status: 422 })
  }

  const stamp = await businessToday(user.orgId)
  const filename = `${safeName(def.slug)}-${stamp}`

  if (format === 'csv') {
    const { sectionHeader } = await reportCsvOptions()
    return csvResponse(exportDataToCsv(data, { sectionHeader }), filename)
  }
  if (format === 'xlsx') {
    const buf = await exportDataToXlsx(data, { reportName: data.title, dateRangeLabel: data.dateRangeLabel })
    return xlsxResponse(buf, filename)
  }
  const { page, showSummary } = resolveLayout(def.layout as Record<string, unknown> | null)
  const branding = await orgBranding()
  const pdf = await exportDataToPdf(data, branding, page, { showSummary })
  return pdfResponse(pdf, filename)
}

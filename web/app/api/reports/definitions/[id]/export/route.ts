import { NextResponse } from 'next/server'
import { getTranslations } from 'next-intl/server'
import { guardPermission } from '../../../../../../lib/authz'
import {
  REPORT_MAX_ROWS,
  executeReport,
  loadReportDefinition,
} from '../../../../../../lib/custom-reports'
import { reportCsvOptions } from '../../../../../../lib/report-labels'
import {
  exportDataToCsv,
  exportDataToPdf,
  exportDataToXlsx,
  orgBranding,
  resolveLayout,
  runResultToExportData,
  type Translator,
} from '../../../../../../lib/report-pdf'
import { csvResponse, pdfResponse, safeName, xlsxResponse } from '../../../../../../lib/export'

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

  const t = (await getTranslations('reports')) as unknown as Translator
  const name =
    def.kind === 'built_in' && tHas(t, `builtIns.${def.slug}.name`)
      ? t(`builtIns.${def.slug}.name`)
      : def.name

  let result
  try {
    result = await executeReport(user.orgId, def.query, REPORT_MAX_ROWS)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Report run failed' },
      { status: 422 },
    )
  }

  const data = runResultToExportData(result, { title: name, dateRangeLabel: '' })
  const stamp = new Date().toISOString().slice(0, 10)
  const filename = `${safeName(def.slug)}-${stamp}`

  if (format === 'csv') {
    const { sectionHeader } = await reportCsvOptions()
    return csvResponse(exportDataToCsv(data, { sectionHeader }), filename)
  }
  if (format === 'xlsx') {
    const buf = await exportDataToXlsx(data, { reportName: name, dateRangeLabel: '' })
    return xlsxResponse(buf, filename)
  }
  const { page, showSummary } = resolveLayout(def.layout as Record<string, unknown> | null)
  const branding = await orgBranding()
  const pdf = await exportDataToPdf(data, branding, page, { showSummary })
  return pdfResponse(pdf, filename)
}

/** next-intl's `t` exposes `.has(key)`; the cast to Translator loses it. */
function tHas(t: Translator, key: string): boolean {
  const fn = t as unknown as { has?: (k: string) => boolean }
  return typeof fn.has === 'function' ? fn.has(key) : false
}

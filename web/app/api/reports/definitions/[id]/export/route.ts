import { NextResponse } from 'next/server'
import { getTranslations } from 'next-intl/server'
import { guardPermission } from '../../../../../../lib/authz'
import { isUuid } from '../../../../../../lib/list-params'
import { guardReportEntity } from '../../../../../../lib/report-authz'
import { loadReportDefinition } from '../../../../../../lib/custom-reports'
import { resolveDefinitionToExportData, streamDefinitionExport } from '../../../../../../lib/report-run'
import { REPORT_ENTITY_MAP } from '@openbooks/reports'
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
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'

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

  if (!isUuid(id)) return NextResponse.json({ error: 'report not found' }, { status: 404 })
  const def = await loadReportDefinition(user.orgId, id)
  if (!def) return NextResponse.json({ error: 'report not found' }, { status: 404 })

  // An export returns the SAME rows the runner does. `reports.read` alone must
  // not reach a payroll plan through the download button.
  const denied = await guardReportEntity(gate, def.query)
  if (denied) return denied

  const t = (await getTranslations('reports')) as unknown as Translator

  // One pipeline for BOTH standard (statement) and custom (query) definitions.
  const q = parseReportQuery(url.searchParams)
  const period = await resolvePeriod(q.period, {
    customFrom: url.searchParams.get('from') ?? undefined,
    customTo: url.searchParams.get('to') ?? undefined,
  })
  const stamp = await businessToday(user.orgId)
  const filename = `${safeName(def.slug)}-${stamp}`

  // Paged-entity CSV/XLSX streams page by page (bounded memory, per-page
  // snapshots, capped with a disclosed footer); every other export keeps the
  // buffered runner so statement kinds, PDFs, and non-paged plans are
  // byte-for-byte what they were.
  const streamQuery = def.report_type === 'query' && def.query && def.query.mode === 'rows'
    ? (REPORT_ENTITY_MAP[def.query.entity]?.pagination ? def.query : null)
    : null
  if (streamQuery && format !== 'pdf') {
    try {
      const out = await streamDefinitionExport(user.orgId, id, url.searchParams, { orgId: user.orgId, t, period, query: q }, {
        format: format as 'csv' | 'xlsx',
        sectionHeader: (await reportCsvOptions()).sectionHeader,
        generatedAt: new Date(`${stamp}T00:00:00Z`),
      })
      if (out.format === 'csv') return csvResponse(out.csv, filename)
      return xlsxResponse(out.xlsx, filename)
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : 'Report run failed' }, { status: 422 })
    }
  }

  let data
  try {
    data = await resolveDefinitionToExportData(user.orgId, id, url.searchParams, { orgId: user.orgId, t, period, query: q })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Report run failed' }, { status: 422 })
  }

  if (format === 'csv') {
    const { sectionHeader } = await reportCsvOptions()
    return csvResponse(exportDataToCsv(data, { sectionHeader }), filename)
  }
  if (format === 'xlsx') {
    const buf = await exportDataToXlsx(data, {
      reportName: data.title,
      dateRangeLabel: data.dateRangeLabel,
      generatedAt: new Date(`${stamp}T00:00:00Z`),
    })
    return xlsxResponse(buf, filename)
  }
  const { page, showSummary } = resolveLayout(def.layout as Record<string, unknown> | null)
  const branding = await orgBranding()
  const pdf = await exportDataToPdf(data, branding, page, {
    showSummary,
    generatedAt: new Date(`${stamp}T00:00:00Z`),
  })
  return pdfResponse(pdf, filename)
}

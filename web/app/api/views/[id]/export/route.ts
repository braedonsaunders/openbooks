import { NextResponse } from 'next/server'
import { guardPermission } from '../../../../../lib/authz'
import { canRunReportEntity } from '../../../../../lib/report-authz'
import { loadView, runView } from '../../../../../lib/views'
import {
  exportDataToCsv,
  exportDataToPdf,
  exportDataToXlsx,
  orgBranding,
  resolveLayout,
  runResultToExportData,
} from '../../../../../lib/report-pdf'
import { reportCsvOptions } from '../../../../../lib/report-labels'
import { csvResponse, pdfResponse, safeName, xlsxResponse } from '../../../../../lib/export'
import { businessToday } from '@openbooks/engine/src/business-date.ts'

export const runtime = 'nodejs'

/** Export a view to PDF, Excel or CSV (runs fresh, current data). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('reports.read')
  if (gate instanceof NextResponse) return gate
  const { user, permissions } = gate
  const { id } = await params

  const url = new URL(req.url)
  const format = (url.searchParams.get('format') ?? 'pdf').toLowerCase()
  if (!['pdf', 'xlsx', 'csv'].includes(format)) {
    return NextResponse.json({ error: 'invalid format' }, { status: 422 })
  }

  const view = await loadView(user.orgId, id, user.id, permissions)
  if (!view) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (!(await canRunReportEntity(gate, view.query))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  let result
  try {
    result = await runView(user.orgId, view.query)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'View failed' },
      { status: 422 },
    )
  }

  const data = runResultToExportData(result, { title: view.name, dateRangeLabel: '' })
  const filename = `${safeName(view.slug)}-${await businessToday(user.orgId)}`

  if (format === 'csv') {
    const { sectionHeader } = await reportCsvOptions()
    return csvResponse(exportDataToCsv(data, { sectionHeader }), filename)
  }
  if (format === 'xlsx') {
    const buf = await exportDataToXlsx(data, { reportName: view.name, dateRangeLabel: '' })
    return xlsxResponse(buf, filename)
  }
  const { page, showSummary } = resolveLayout(view.layout)
  const branding = await orgBranding()
  const pdf = await exportDataToPdf(data, branding, page, { showSummary })
  return pdfResponse(pdf, filename)
}

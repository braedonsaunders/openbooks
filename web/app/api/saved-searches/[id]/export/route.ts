import { NextResponse } from 'next/server'
import { guardPermission } from '../../../../../lib/authz'
import { loadSavedSearch, runSavedSearch } from '../../../../../lib/saved-searches'
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

export const runtime = 'nodejs'

/** Export a saved search to PDF, Excel or CSV (runs fresh, current data). */
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

  const search = await loadSavedSearch(user.orgId, id, user.id, permissions)
  if (!search) return NextResponse.json({ error: 'not found' }, { status: 404 })

  let result
  try {
    result = await runSavedSearch(user.orgId, search.query)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Saved search failed' },
      { status: 422 },
    )
  }

  const data = runResultToExportData(result, { title: search.name, dateRangeLabel: '' })
  const filename = `${safeName(search.slug)}-${new Date().toISOString().slice(0, 10)}`

  if (format === 'csv') {
    const { sectionHeader } = await reportCsvOptions()
    return csvResponse(exportDataToCsv(data, { sectionHeader }), filename)
  }
  if (format === 'xlsx') {
    const buf = await exportDataToXlsx(data, { reportName: search.name, dateRangeLabel: '' })
    return xlsxResponse(buf, filename)
  }
  const { page, showSummary } = resolveLayout(search.layout)
  const branding = await orgBranding()
  const pdf = await exportDataToPdf(data, branding, page, { showSummary })
  return pdfResponse(pdf, filename)
}

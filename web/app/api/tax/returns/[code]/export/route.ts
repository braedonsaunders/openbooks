import { NextResponse } from 'next/server'
import { getTranslations } from 'next-intl/server'
import { computeTaxReturn } from '@openbooks/engine/src/tax-return.ts'
import { guardPermission } from '../../../../../../lib/authz'
import {
  exportDataToCsv,
  exportDataToPdf,
  exportDataToXlsx,
  orgBranding,
  resolveLayout,
  type Translator,
} from '../../../../../../lib/report-pdf'
import { taxReturnExportData } from '../../../../../../lib/tax-filing'
import { csvResponse, pdfResponse, safeName, xlsxResponse } from '../../../../../../lib/export'

export const runtime = 'nodejs'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Export a computed tax return as a facsimile PDF (or CSV / XLSX). */
export async function GET(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const gate = await guardPermission('reports.read')
  if (gate instanceof NextResponse) return gate
  const { code } = await params
  const p = new URL(req.url).searchParams
  const from = p.get('from')
  const to = p.get('to')
  const format = (p.get('format') ?? 'pdf').toLowerCase()
  if (!from || !to || !DATE_RE.test(from) || !DATE_RE.test(to)) {
    return NextResponse.json({ error: 'from and to dates (YYYY-MM-DD) are required' }, { status: 422 })
  }
  if (!['pdf', 'xlsx', 'csv'].includes(format)) {
    return NextResponse.json({ error: 'invalid format' }, { status: 422 })
  }

  try {
    const t = (await getTranslations('tax')) as unknown as Translator
    const result = await computeTaxReturn(gate.user.orgId, code, from, to)
    const data = taxReturnExportData(result, t)
    const filename = `${safeName(code)}-${from}-${to}`

    if (format === 'csv') {
      return csvResponse(exportDataToCsv(data, { sectionHeader: data.title }), filename)
    }
    if (format === 'xlsx') {
      return xlsxResponse(await exportDataToXlsx(data, { reportName: data.title, dateRangeLabel: data.dateRangeLabel }), filename)
    }
    const branding = await orgBranding()
    const { page, showSummary } = resolveLayout(null)
    return pdfResponse(await exportDataToPdf(data, branding, page, { showSummary }), filename)
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'export failed' }, { status: 422 })
  }
}

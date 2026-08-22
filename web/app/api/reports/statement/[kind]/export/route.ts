import { NextResponse } from 'next/server'
import { getTranslations } from 'next-intl/server'
import { guardPermission } from '../../../../../../lib/authz'
import {
  exportDataToCsv,
  exportDataToPdf,
  exportDataToXlsx,
  orgBranding,
  renderStatementViewPdf,
  resolveLayout,
  statementViewToExportData,
  statementViewToXlsx,
  type ExportData,
  type Translator,
} from '../../../../../../lib/report-pdf'
import { isReportKind, resolveReport, type ReportKind } from '../../../../../../lib/report-run'
import { resolvePdfPageSetup } from '@openbooks/pdf'
import { resolvePeriod } from '../../../../../../lib/periods'
import { parseReportQuery } from '../../../../../../lib/report-filters'
import { reportCsvOptions } from '../../../../../../lib/report-labels'
import { csvResponse, pdfResponse, safeName, xlsxResponse } from '../../../../../../lib/export'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
import { isFeatureEnabled } from '../../../../../../lib/features'
import { guardProjectsFeature } from '../../../../../../lib/projects-gate'
import { renderGeneralLedgerPaperPdf } from '../../../../../../lib/general-ledger-pdf'

export const runtime = 'nodejs'

export async function GET(req: Request, { params }: { params: Promise<{ kind: string }> }) {
  const gate = await guardPermission('reports.read')
  if (gate instanceof NextResponse) return gate
  const { kind } = await params
  if (!isReportKind(kind)) {
    return NextResponse.json({ error: 'unknown statement' }, { status: 422 })
  }
  if (kind === 'project-profitability') {
    const feature = await guardProjectsFeature(gate.user.orgId)
    if (feature) return feature
  }
  if (kind === 'budget' && !(await isFeatureEnabled(gate.user.orgId, 'budgets'))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  const url = new URL(req.url)
  const p = url.searchParams
  const format = (p.get('format') ?? 'pdf').toLowerCase()
  if (!['pdf', 'xlsx', 'csv'].includes(format)) {
    return NextResponse.json({ error: 'invalid format' }, { status: 422 })
  }

  const t = (await getTranslations('reports')) as unknown as Translator
  const stamp = await businessToday(gate.user.orgId)
  const filename = `${safeName(kind)}-${stamp}`
  const branding = await orgBranding()

  const emitData = async (data: ExportData) => {
    if (format === 'csv') {
      const { sectionHeader } = await reportCsvOptions()
      return csvResponse(exportDataToCsv(data, { sectionHeader }), filename)
    }
    if (format === 'xlsx') {
      return xlsxResponse(await exportDataToXlsx(data, { reportName: data.title, dateRangeLabel: data.dateRangeLabel }), filename)
    }
    const { page, showSummary } = resolveLayout(null)
    return pdfResponse(await exportDataToPdf(data, branding, page, {
      showSummary,
      generatedAt: new Date(`${stamp}T00:00:00Z`),
    }), filename)
  }

  try {
    const q = parseReportQuery(p)
    const period = await resolvePeriod(q.period, { customFrom: p.get('from'), customTo: p.get('to') })
    const resolved = await resolveReport(kind as ReportKind, p, { orgId: gate.user.orgId, t, period, query: q })

    if (resolved.render === 'view') {
      const { view, title, periodPhrase } = resolved
      if (format === 'pdf') {
        const page = resolvePdfPageSetup({
          paperSize: 'letter',
          orientation: view.columns.length > 4 ? 'landscape' : 'portrait',
          marginMm: 16,
          density: 'standard',
        })
        return pdfResponse(await renderStatementViewPdf(view, branding, page, {
          title,
          periodPhrase,
          scale: q.scale,
          generatedAt: new Date(`${stamp}T00:00:00Z`),
        }), filename)
      }
      if (format === 'xlsx') {
        return xlsxResponse(
          await statementViewToXlsx(view, {
            company: branding.orgName,
            title,
            periodPhrase,
            accountLabel: t('export.columns.accountName'),
            generatedAt: new Date(`${stamp}T00:00:00Z`),
          }),
          filename,
        )
      }
      return emitData(statementViewToExportData(view, { title, dateRangeLabel: periodPhrase, accountLabel: t('export.columns.accountName') }))
    }

    if (format === 'pdf' && kind === 'general-ledger') {
      const { page } = resolveLayout(null)
      return pdfResponse(
        await renderGeneralLedgerPaperPdf(resolved.data, branding, page),
        filename,
      )
    }

    return emitData(resolved.data)
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Statement failed' }, { status: 422 })
  }
}

import { NextResponse } from 'next/server'
import { getTranslations } from 'next-intl/server'
import { guardPermission } from '../../../../../../lib/authz'
import {
  agingByParty,
  balanceSheet,
  cashFlow,
  partnerBalances,
  profitAndLoss,
  trialBalance,
  currentFiscalYearEnd,
  fiscalYearRange,
} from '../../../../../../lib/reports'
import {
  agingExportData,
  balanceSheetExportData,
  cashFlowExportData,
  exportDataToCsv,
  exportDataToPdf,
  exportDataToXlsx,
  orgBranding,
  partnersExportData,
  pnlExportData,
  resolveLayout,
  trialBalanceExportData,
  type Translator,
} from '../../../../../../lib/report-pdf'
import { reportCsvOptions } from '../../../../../../lib/report-labels'
import { csvResponse, pdfResponse, safeName, xlsxResponse } from '../../../../../../lib/export'

export const runtime = 'nodejs'

const KINDS = ['pnl', 'balance-sheet', 'trial-balance', 'partners', 'aging', 'cash-flow'] as const
type Kind = (typeof KINDS)[number]

export async function GET(req: Request, { params }: { params: Promise<{ kind: string }> }) {
  const gate = await guardPermission('reports.read')
  if (gate instanceof NextResponse) return gate
  const { kind } = await params
  if (!KINDS.includes(kind as Kind)) {
    return NextResponse.json({ error: 'unknown statement' }, { status: 422 })
  }

  const url = new URL(req.url)
  const format = (url.searchParams.get('format') ?? 'pdf').toLowerCase()
  if (!['pdf', 'xlsx', 'csv'].includes(format)) {
    return NextResponse.json({ error: 'invalid format' }, { status: 422 })
  }

  const p = url.searchParams
  const dept = p.get('dept') || undefined
  const project = p.get('project') || undefined
  const dims = { departmentId: dept, projectId: project }
  const asOf = p.get('asOf') ?? new Date().toISOString().slice(0, 10)

  const fyNow = await currentFiscalYearEnd()
  const fy = await fiscalYearRange(fyNow)
  const from = p.get('from') ?? fy.from
  const to = p.get('to') ?? fy.to

  const t = (await getTranslations('reports')) as unknown as Translator

  let data
  try {
    switch (kind as Kind) {
      case 'pnl': {
        const pl = await profitAndLoss(from, to, dims)
        data = pnlExportData(pl, from, to, t)
        break
      }
      case 'balance-sheet': {
        const bs = await balanceSheet(asOf)
        data = balanceSheetExportData(bs, asOf, t)
        break
      }
      case 'trial-balance': {
        const rows = await trialBalance(asOf, dims)
        data = trialBalanceExportData(rows, asOf, t)
        break
      }
      case 'partners': {
        const side = (p.get('side') === 'receivable' ? 'receivable' : 'payable') as 'receivable' | 'payable'
        const rows = await partnerBalances(side)
        data = partnersExportData(side, rows, t)
        break
      }
      case 'aging': {
        const s = p.get('side') === 'ar' ? 'ar' : 'ap'
        const result = await agingByParty(s, asOf, dims)
        data = agingExportData(s, result, t)
        break
      }
      case 'cash-flow': {
        const cf = await cashFlow(from, to, dims)
        data = cashFlowExportData(cf, from, to, t)
        break
      }
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Statement failed' },
      { status: 422 },
    )
  }

  const filename = `${safeName(kind)}-${new Date().toISOString().slice(0, 10)}`

  if (format === 'csv') {
    const { sectionHeader } = await reportCsvOptions()
    return csvResponse(exportDataToCsv(data!, { sectionHeader }), filename)
  }
  if (format === 'xlsx') {
    const buf = await exportDataToXlsx(data!, { reportName: data!.title, dateRangeLabel: data!.dateRangeLabel })
    return xlsxResponse(buf, filename)
  }
  const { page, showSummary } = resolveLayout(null)
  const branding = await orgBranding()
  const pdf = await exportDataToPdf(data!, branding, page, { showSummary })
  return pdfResponse(pdf, filename)
}

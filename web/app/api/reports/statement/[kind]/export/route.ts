import { NextResponse } from 'next/server'
import { getTranslations } from 'next-intl/server'
import { guardPermission } from '../../../../../../lib/authz'
import {
  agingByParty,
  cashFlow,
  generalLedger,
  journalReport,
  partnerBalances,
  partnerStatement,
  partyRegister,
  trialBalance,
  type AgingSide,
} from '../../../../../../lib/reports'
import { balanceSheetView, profitAndLossView, type StatementView } from '../../../../../../lib/statement-matrix'
import { budgetVsActualView } from '../../../../../../lib/budget-report'
import { resolvePeriod } from '../../../../../../lib/periods'
import { parseReportQuery } from '../../../../../../lib/report-filters'
import {
  agingExportData,
  cashFlowExportData,
  exportDataToCsv,
  exportDataToPdf,
  exportDataToXlsx,
  generalLedgerExportData,
  journalExportData,
  orgBranding,
  partnersExportData,
  partnerStatementExportData,
  registerExportData,
  renderStatementViewPdf,
  resolveLayout,
  statementViewToExportData,
  trialBalanceExportData,
  type ExportData,
  type Translator,
} from '../../../../../../lib/report-pdf'
import { resolvePdfPageSetup } from '@openbooks/pdf'
import { reportCsvOptions } from '../../../../../../lib/report-labels'
import { csvResponse, pdfResponse, safeName, xlsxResponse } from '../../../../../../lib/export'

export const runtime = 'nodejs'

const KINDS = [
  'pnl',
  'balance-sheet',
  'trial-balance',
  'partners',
  'aging',
  'cash-flow',
  'general-ledger',
  'journal',
  'registers',
  'budget',
  'partner-statement',
] as const
type Kind = (typeof KINDS)[number]
// Kinds that render through the multi-column statement engine (StatementView).
const VIEW_KINDS = new Set<Kind>(['pnl', 'balance-sheet', 'budget'])

export async function GET(req: Request, { params }: { params: Promise<{ kind: string }> }) {
  const gate = await guardPermission('reports.read')
  if (gate instanceof NextResponse) return gate
  const { kind } = await params
  if (!KINDS.includes(kind as Kind)) {
    return NextResponse.json({ error: 'unknown statement' }, { status: 422 })
  }

  const url = new URL(req.url)
  const p = url.searchParams
  const format = (p.get('format') ?? 'pdf').toLowerCase()
  if (!['pdf', 'xlsx', 'csv'].includes(format)) {
    return NextResponse.json({ error: 'invalid format' }, { status: 422 })
  }

  const t = (await getTranslations('reports')) as unknown as Translator
  const filename = `${safeName(kind)}-${new Date().toISOString().slice(0, 10)}`
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
    return pdfResponse(await exportDataToPdf(data, branding, page, { showSummary }), filename)
  }

  try {
    const q = parseReportQuery(p)
    const period = await resolvePeriod(q.period, { customFrom: p.get('from'), customTo: p.get('to') })
    const dims = { departmentId: q.dims.departmentId, projectId: q.dims.projectId, locationId: q.dims.locationId, classId: q.dims.classId }
    const secTotal = (section: string) => t('statement.sectionTotal', { section })

    // --- Multi-column statement views (P&L, Balance Sheet, Budget) -----------
    if (VIEW_KINDS.has(kind as Kind)) {
      let view: StatementView | null = null
      let title = ''
      let periodPhrase = ''
      const matrixOpts = { breakout: q.breakout, compare: q.compare, basis: q.basis, dims: q.dims, showZero: q.showZero }
      if (kind === 'pnl') {
        title = t('pnl.title')
        periodPhrase = t('pnl.dateRange', { from: period.from, to: period.to })
        view = await profitAndLossView({ from: period.from, to: period.to }, period.label, {
          revenue: t('pnl.revenue'), costOfGoodsSold: t('pnl.costOfGoodsSold'), grossProfit: t('pnl.grossProfit'),
          expenses: t('pnl.expenses'), netIncome: t('pnl.netIncome'), totalOf: secTotal,
        }, matrixOpts)
      } else if (kind === 'balance-sheet') {
        title = t('balanceSheet.title')
        periodPhrase = t('balanceSheet.asOf', { date: period.to })
        view = await balanceSheetView({ from: period.from, to: period.to }, period.label, {
          assets: t('balanceSheet.assets'), liabilities: t('balanceSheet.liabilities'), equity: t('balanceSheet.equity'),
          totalAssets: secTotal(t('balanceSheet.assets')), totalLiabilities: secTotal(t('balanceSheet.liabilities')),
          totalEquity: secTotal(t('balanceSheet.equity')), accumulatedEarnings: t('statement.accumulatedEarnings'),
          liabilitiesAndEquity: t('balanceSheet.liabilitiesAndEquity'), totalOf: secTotal,
        }, matrixOpts)
      } else {
        title = t('budget.title')
        periodPhrase = t('budget.description')
        const scenario = p.get('scenario')
        if (scenario) {
          view = await budgetVsActualView(scenario, {
            actual: t('budget.actual'), budget: t('budget.budget'), variance: t('budget.variance'), variancePct: t('budget.variancePct'),
            revenue: t('pnl.revenue'), costOfGoodsSold: t('pnl.costOfGoodsSold'), grossProfit: t('pnl.grossProfit'),
            expenses: t('pnl.expenses'), netIncome: t('pnl.netIncome'), totalOf: secTotal,
          })
        }
      }
      if (!view) return NextResponse.json({ error: 'no data' }, { status: 422 })

      if (format === 'pdf') {
        const page = resolvePdfPageSetup({ paperSize: 'letter', orientation: view.columns.length > 4 ? 'landscape' : 'portrait', marginMm: 16, density: 'standard' })
        return pdfResponse(await renderStatementViewPdf(view, branding, page, { title, periodPhrase, scale: q.scale }), filename)
      }
      const data = statementViewToExportData(view, { title, dateRangeLabel: periodPhrase, accountLabel: t('export.columns.accountName') })
      return emitData(data)
    }

    // --- Detail reports (flat tables) ----------------------------------------
    const side: AgingSide = p.get('side') === 'ap' ? 'ap' : 'ar'
    switch (kind as Kind) {
      case 'general-ledger':
        return emitData(generalLedgerExportData(await generalLedger(period.from, period.to, { accountId: p.get('account') ?? undefined, dims }), t('generalLedger.title'), t))
      case 'journal':
        return emitData(journalExportData(await journalReport(period.from, period.to, { dims }), t('journal.title'), t))
      case 'registers':
        return emitData(registerExportData(await partyRegister(side, { from: period.from, to: period.to, dims }), side === 'ap' ? t('registers.apTitle') : t('registers.arTitle'), t))
      case 'partner-statement': {
        const partyId = p.get('party')
        if (!partyId) return NextResponse.json({ error: 'party required' }, { status: 422 })
        return emitData(partnerStatementExportData(await partnerStatement(partyId, { from: period.from, to: period.to, side }), t))
      }
    }

    // --- Legacy single-column statements -------------------------------------
    const asOf = p.get('asOf') ?? period.to
    const from = p.get('from') ?? period.from
    const to = p.get('to') ?? period.to
    let data: ExportData
    switch (kind as Kind) {
      case 'trial-balance':
        data = trialBalanceExportData(await trialBalance(asOf, dims), asOf, t)
        break
      case 'partners': {
        const s = (p.get('side') === 'receivable' ? 'receivable' : 'payable') as 'receivable' | 'payable'
        data = partnersExportData(s, await partnerBalances(s), t)
        break
      }
      case 'aging':
        data = agingExportData(side, await agingByParty(side, asOf, dims), t)
        break
      case 'cash-flow':
        data = cashFlowExportData(await cashFlow(from, to, dims), from, to, t)
        break
      default:
        return NextResponse.json({ error: 'unknown statement' }, { status: 422 })
    }
    return emitData(data)
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Statement failed' }, { status: 422 })
  }
}

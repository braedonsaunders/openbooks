import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import {
  renderPdfDocument,
  renderStatementPdf,
  resolvePdfPageSetup,
  type PdfBranding,
  type PdfColumnAlign,
  type PdfDocumentInput,
  type PdfPageSetup,
  type PdfTableGroup,
  type StatementPdfStyle,
} from '@openbooks/pdf'
import type { StatementView } from './statement-matrix'
import { decimalIsMaterial, decimalIsZero, decimalScale, decimalSum, type ExactDecimal } from './statement-format'
import {
  reportResultToXlsx,
  reportResultToCsv,
  statementSheetToXlsx,
  type ReportRunResult,
} from '@openbooks/office'
import type {
  ReportGroup,
  ReportLayoutConfig,
  ReportRunLabels,
  ReportSummaryItem,
} from '@openbooks/reports'
import { resolveReportLayout } from '@openbooks/reports'
import { resolveOrgId } from './org-scope'
import { resolveLocale } from './locale'
import { isExactDecimalText, pdfMoney } from './report-pdf-detail'
export { generalLedgerExportData } from './report-pdf-detail'

/**
 * Export pipeline for reports: a single intermediate shape (ExportData) feeds
 * PDF, Excel and CSV. Custom reports arrive as a ReportRunResult (numbers
 * preserved for Excel); financial statements are shaped by the adapters below.
 *
 * Money columns carry the ledger's exact decimal STRINGS and are marked with
 * per-group `money` flags (mirroring ReportGroup.money). The PDF formats them
 * through Intl mathematical values — never IEEE-754, which loses precision
 * past 2^53; see report-pdf-detail.ts. Excel/CSV receive doubles produced once
 * at the spreadsheet boundary (exportDataToRunResult), because .xlsx stores
 * binary floats natively. Counts stay plain numbers.
 */

export type Translator = (key: string, values?: Record<string, string | number>) => string

/** PdfTableGroup plus per-column currency markers: flagged columns hold exact
 *  ledger decimal strings that must reach print without an IEEE-754 round-trip. */
export type ExportTableGroup = PdfTableGroup & { money?: boolean[] }

export type ExportData = {
  title: string
  dateRangeLabel: string
  summary: ReportSummaryItem[]
  groups: ExportTableGroup[]
}

// --- branding ---------------------------------------------------------------

export async function orgBranding(orgId?: string): Promise<PdfBranding & { reportPdfStyle: StatementPdfStyle; baseCurrency: string }> {
  const activeOrgId = await resolveOrgId(orgId)
  const r = (await db.execute<{ name: string; base_currency: string; brand_primary: string | null; report_pdf_style: string | null }>(sql`
    select name, base_currency,
           settings ->> 'brandPrimary' as brand_primary,
           settings ->> 'reportPdfStyle' as report_pdf_style
      from orgs
     where id = ${activeOrgId}
  `))
  const row = r.rows[0]
  return {
    orgName: row?.name ?? 'openbooks',
    primaryColor: row?.brand_primary || null,
    reportPdfStyle: row?.report_pdf_style === 'formal' ? 'formal' : 'modern',
    baseCurrency: row?.base_currency ?? 'USD',
  }
}

// --- layout -----------------------------------------------------------------

export function resolveLayout(layout?: Partial<ReportLayoutConfig> | null): {
  page: PdfPageSetup
  showSummary: boolean
} {
  const resolved = resolveReportLayout(layout)
  return {
    page: resolvePdfPageSetup({
      paperSize: resolved.paperSize,
      orientation: resolved.orientation,
      marginMm: resolved.marginMm,
      density: resolved.density,
    }),
    showSummary: resolved.showSummary !== false,
  }
}

// --- shared converters ------------------------------------------------------

/** Format a number for the PDF: counts stay clean, money gets 2 decimals. */
export function pdfNum(v: number, locale = 'en'): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: Number.isInteger(v) ? 0 : 2 }).format(v)
}

function pdfCell(v: string | number | null | undefined, locale: string, isMoney = false): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'number') return pdfNum(v, locale)
  // pdfMoney self-guards: non-numeric text in a flagged column renders raw.
  if (isMoney) return pdfMoney(v, locale)
  return String(v)
}

function pdfSummary(s: ReportSummaryItem, locale: string): { label: string; value: string } {
  return {
    label: s.label,
    value: typeof s.value === 'number'
      ? pdfNum(s.value, locale)
      : s.money === true
        ? pdfMoney(s.value, locale)
        : String(s.value),
  }
}

/** Turn a ReportRunResult into the shared ExportData (title/range from caller). */
export function runResultToExportData(
  result: ReportRunResult,
  opts: { title: string; dateRangeLabel: string },
): ExportData {
  return {
    title: opts.title,
    dateRangeLabel: opts.dateRangeLabel,
    summary: result.summary,
    groups: result.groups.map((g) => ({
      kind: g.kind,
      title: g.title,
      subtitle: g.subtitle,
      columns: g.columns,
      rows: g.rows,
      ...(g.money ? { money: g.money } : {}),
      align: undefined,
      isEmpty: g.isEmpty,
    })),
  }
}

/** ExportData → ReportRunResult for Excel/CSV. Flagged money columns hold the
 *  ledger's exact decimal strings; this boundary is where they become doubles
 *  (once per cell), because spreadsheet files store IEEE-754 natively — the
 *  same single conversion statementSheetToXlsx performs. */
export function exportDataToRunResult(data: ExportData): ReportRunResult {
  const groups: ReportGroup[] = data.groups.map((g) => ({
    kind: g.kind,
    title: g.title,
    subtitle: g.subtitle,
    columns: g.columns,
    rows: g.rows.map((row) => row.map((cell, i) =>
      g.money?.[i] === true && typeof cell === 'string' && isExactDecimalText(cell) ? Number(cell) : cell,
    )),
    ...(g.money ? { money: g.money } : {}),
    isEmpty: g.isEmpty,
  }))
  const rowCount = data.groups.reduce((n, g) => n + g.rows.length, 0)
  return { groups, summary: data.summary, rowCount }
}

/** ExportData → PDF input (numbers formatted for human reading). */
export function exportDataToPdfInput(
  data: ExportData,
  branding: PdfBranding,
  page: PdfPageSetup,
  opts: { showSummary?: boolean; generatedAt?: Date; footerLeft?: string; locale?: string } = {},
): PdfDocumentInput {
  const locale = opts.locale ?? 'en'
  const groups: PdfTableGroup[] = data.groups.map((g) => ({
    kind: g.kind,
    title: g.title,
    subtitle: g.subtitle,
    columns: g.columns,
    rows: g.rows.map((row) => row.map((cell, i) => pdfCell(cell, locale, g.money?.[i] === true))),
    align: g.align,
    isEmpty: g.isEmpty,
  }))
  return {
    title: data.title,
    dateRangeLabel: data.dateRangeLabel,
    generatedAt: opts.generatedAt ?? new Date(),
    branding,
    summary: opts.showSummary === false ? undefined : data.summary.map((item) => pdfSummary(item, locale)),
    groups,
    layout: page,
    footerLeft: opts.footerLeft,
  }
}

export async function exportDataToPdf(data: ExportData, branding: PdfBranding, page: PdfPageSetup, opts?: { showSummary?: boolean; generatedAt?: Date }): Promise<Buffer> {
  const locale = await resolveLocale()
  return renderPdfDocument(exportDataToPdfInput(data, branding, page, { ...opts, locale }))
}

export async function exportDataToXlsx(data: ExportData, opts: { reportName: string; dateRangeLabel?: string; generatedAt?: Date }): Promise<Buffer> {
  return reportResultToXlsx(exportDataToRunResult(data), opts)
}

export function exportDataToCsv(data: ExportData, opts: { sectionHeader?: string }): string {
  return reportResultToCsv(exportDataToRunResult(data), opts)
}

// --- financial-statement adapters ------------------------------------------
// Each returns an ExportData with numeric cells (so Excel stays numeric).
// Financial aggregation remains exact; conversion happens once per final cell.
// Section/group titles and column headers come through the reports translator
// (keys under reports.* — see web/messages/<locale>/reports.json).

type StatementRow = {
  id: string
  number: string | null
  name: string
  type: string
  balance: ExactDecimal
  depth: number
  isSummary: boolean
}

const MONEY_ALIGN: PdfColumnAlign[] = ['left', 'left', 'right']

function indent(d: number): string {
  return d > 0 ? ' '.repeat(d * 2) : ''
}

function statementGroup(
  t: Translator,
  sectionKey: string,
  sectionTitle: string,
  items: StatementRow[],
  types: string[],
  total: ExactDecimal,
): ExportTableGroup {
  const rows = items
    .filter((r) => types.includes(r.type))
    .map((r) => [r.number ?? '', `${indent(r.depth)}${r.name}`, r.balance] as (string | number)[])
  rows.push(['', t('statement.sectionTotal', { section: sectionTitle }), total])
  return {
    kind: 'section',
    title: sectionTitle,
    columns: [t('export.columns.accountNumber'), t('export.columns.accountName'), t('export.columns.amount')],
    rows,
    align: MONEY_ALIGN,
    money: [false, false, true],
  }
}

export function pnlExportData(
  pl: { items: StatementRow[]; revenue: ExactDecimal; cogs: ExactDecimal; grossProfit: ExactDecimal; expenses: ExactDecimal; netIncome: ExactDecimal },
  from: string,
  to: string,
  t: Translator,
): ExportData {
  const revenueTitle = t('pnl.revenue')
  const cogsTitle = t('pnl.costOfGoodsSold')
  const expensesTitle = t('pnl.expenses')
  return {
    title: t('pnl.title'),
    dateRangeLabel: t('pnl.dateRange', { from, to }),
    summary: [
      { label: revenueTitle, value: pl.revenue, money: true },
      { label: t('pnl.grossProfit'), value: pl.grossProfit, money: true },
      { label: t('pnl.netIncome'), value: pl.netIncome, money: true },
    ],
    groups: [
      statementGroup(t, 'revenue', revenueTitle, pl.items, ['income', 'income_other'], pl.revenue),
      statementGroup(t, 'cogs', cogsTitle, pl.items, ['cogs'], pl.cogs),
      statementGroup(t, 'expenses', expensesTitle, pl.items, ['expense', 'expense_other', 'expense_deferred'], pl.expenses),
      {
        kind: 'summary',
        title: t('pnl.netIncome'),
        columns: [t('export.columns.accountName'), t('export.columns.amount')],
        rows: [[t('pnl.netIncome'), pl.netIncome]],
        align: ['left', 'right'],
        money: [false, true],
      },
    ],
  }
}

export function balanceSheetExportData(
  bs: { assets: StatementRow[]; liabilities: StatementRow[]; equity: StatementRow[]; totalAssets: ExactDecimal; totalLiabilities: ExactDecimal; totalEquity: ExactDecimal },
  asOf: string,
  t: Translator,
): ExportData {
  const assetsTitle = t('balanceSheet.assets')
  const liabTitle = t('balanceSheet.liabilities')
  const equityTitle = t('balanceSheet.equity')
  const groupFor = (title: string, items: StatementRow[], total: ExactDecimal) =>
    statementGroup(t, title, title, items, items.map((i) => i.type), total)
  return {
    title: t('balanceSheet.title'),
    dateRangeLabel: t('balanceSheet.asOf', { date: asOf }),
    summary: [
      { label: assetsTitle, value: bs.totalAssets, money: true },
      { label: liabTitle, value: bs.totalLiabilities, money: true },
      { label: equityTitle, value: bs.totalEquity, money: true },
    ],
    groups: [
      groupFor(assetsTitle, bs.assets, bs.totalAssets),
      groupFor(liabTitle, bs.liabilities, bs.totalLiabilities),
      groupFor(equityTitle, bs.equity, bs.totalEquity),
    ],
  }
}

export function projectProfitabilityExportData(
  result: {
    rows: {
      projectName: string; customerName: string | null
      revenue: ExactDecimal; cogs: ExactDecimal; grossProfit: ExactDecimal; expenses: ExactDecimal; net: ExactDecimal; margin: ExactDecimal | null; hours: number
    }[]
    customers: {
      customerName: string | null
      rows: {
        projectName: string
        revenue: ExactDecimal; cogs: ExactDecimal; grossProfit: ExactDecimal; expenses: ExactDecimal; net: ExactDecimal; margin: ExactDecimal | null; hours: number
      }[]
      totals: { revenue: ExactDecimal; cogs: ExactDecimal; grossProfit: ExactDecimal; expenses: ExactDecimal; net: ExactDecimal; margin: ExactDecimal | null; hours: number }
    }[]
    totals: { revenue: ExactDecimal; cogs: ExactDecimal; grossProfit: ExactDecimal; expenses: ExactDecimal; net: ExactDecimal; margin: ExactDecimal | null; hours: number }
    from: string
    to: string
  },
  t: Translator,
): ExportData {
  const pct = (m: ExactDecimal | null) => (m === null ? '' : `${(Number(m) * 100).toFixed(1)}%`)
  const cols = [
    t('projectProfitability.columns.customerJob'),
    t('projectProfitability.columns.revenue'),
    t('projectProfitability.columns.cogs'),
    t('projectProfitability.columns.grossProfit'),
    t('projectProfitability.columns.expenses'),
    t('projectProfitability.columns.net'),
    t('projectProfitability.columns.margin'),
    t('projectProfitability.columns.hours'),
  ]
  const data = result.customers.flatMap((customer) => [
    [
      customer.customerName ?? t('projectProfitability.noCustomer'),
      customer.totals.revenue, customer.totals.cogs, customer.totals.grossProfit,
      customer.totals.expenses, customer.totals.net, pct(customer.totals.margin), customer.totals.hours,
    ],
    ...customer.rows.map((row) => [
      `  ${row.projectName}`,
      row.revenue, row.cogs, row.grossProfit, row.expenses, row.net, pct(row.margin), row.hours,
    ]),
  ] as (string | number)[][])
  data.push([
    t('trialBalance.totals'),
    result.totals.revenue, result.totals.cogs, result.totals.grossProfit,
    result.totals.expenses, result.totals.net, pct(result.totals.margin), result.totals.hours,
  ])
  return {
    title: t('projectProfitability.title'),
    dateRangeLabel: t('pnl.dateRange', { from: result.from, to: result.to }),
    summary: [
      { label: t('projectProfitability.columns.revenue'), value: result.totals.revenue, money: true },
      { label: t('projectProfitability.columns.net'), value: result.totals.net, money: true },
    ],
    groups: [
      {
        kind: 'results',
        title: t('projectProfitability.title'),
        columns: cols,
        rows: data,
        align: ['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right'],
        money: [false, true, true, true, true, true, false, false],
      },
    ],
  }
}

export function trialBalanceExportData(
  rows: { number: string | null; name: string; type: string; debits: string; credits: string; balance: string }[],
  asOf: string,
  t: Translator,
): ExportData {
  const data = rows.map((r) => [r.number ?? '', r.name, r.debits, r.credits, r.balance] as (string | number)[])
  const totalDebits = decimalSum(rows.map((row) => row.debits))
  const totalCredits = decimalSum(rows.map((row) => row.credits))
  const totalBalance = decimalSum(rows.map((row) => row.balance))
  data.push(['', t('trialBalance.totals'), totalDebits, totalCredits, totalBalance])
  return {
    title: t('trialBalance.title'),
    dateRangeLabel: t('trialBalance.description', { date: asOf, count: rows.length }),
    summary: [
      { label: t('trialBalance.columns.debits'), value: totalDebits, money: true },
      { label: t('trialBalance.columns.credits'), value: totalCredits, money: true },
    ],
    groups: [
      {
        kind: 'results',
        title: t('trialBalance.title'),
        columns: [
          t('export.columns.accountNumber'),
          t('export.columns.accountName'),
          t('trialBalance.columns.debits'),
          t('trialBalance.columns.credits'),
          t('export.columns.balance'),
        ],
        rows: data,
        align: ['left', 'left', 'right', 'right', 'right'],
        money: [false, false, true, true, true],
      },
    ],
  }
}

export function partnersExportData(
  kind: 'receivable' | 'payable',
  rows: { id: string | null; display_name: string | null; balance: string; line_count: string; latest_due: string | null }[],
  t: Translator,
): ExportData {
  const title = kind === 'receivable' ? t('partners.receivablesTitle') : t('partners.payablesTitle')
  const total = decimalSum(rows.map((row) => row.balance))
  const data = rows.map((r) => [
    r.display_name ?? t('partners.noPartyOnLines'),
    r.balance,
    Number(r.line_count),
    r.latest_due ?? '',
  ] as (string | number)[])
  return {
    title,
    dateRangeLabel: t('partners.description'),
    summary: [
      { label: t('partners.totalOutstanding'), value: total, money: true },
      { label: t('partners.partiesWithBalance'), value: rows.length },
    ],
    groups: [
      {
        kind: 'results',
        title,
        columns: [t('export.columns.party'), t('partners.columns.outstanding'), t('partners.columns.glLines'), t('export.columns.latestDue')],
        rows: data,
        align: ['left', 'right', 'right', 'left'],
        money: [false, true, false, false],
      },
    ],
  }
}

export function agingExportData(
  side: 'ar' | 'ap',
  result: {
    rows: { partyName: string | null; current: ExactDecimal; b1: ExactDecimal; b2: ExactDecimal; b3: ExactDecimal; b4: ExactDecimal; total: ExactDecimal }[]
    totals: { current: ExactDecimal; b1: ExactDecimal; b2: ExactDecimal; b3: ExactDecimal; b4: ExactDecimal; total: ExactDecimal }
    asOf: string
  },
  t: Translator,
): ExportData {
  const title = side === 'ar' ? t('aging.receivablesTitle') : t('aging.payablesTitle')
  const cols = [
    t('export.columns.party'),
    t('aging.buckets.current'),
    t('aging.buckets.b1'),
    t('aging.buckets.b2'),
    t('aging.buckets.b3'),
    t('aging.buckets.b4'),
    t('aging.columns.total'),
  ]
  const data = result.rows.map((r) => [
    r.partyName ?? t('aging.noParty'),
    r.current, r.b1, r.b2, r.b3, r.b4, r.total,
  ] as (string | number)[])
  data.push([
    t('trialBalance.totals'),
    result.totals.current, result.totals.b1, result.totals.b2, result.totals.b3, result.totals.b4, result.totals.total,
  ])
  return {
    title,
    dateRangeLabel: t('aging.asOf', { date: result.asOf }),
    summary: [{ label: t('aging.columns.total'), value: result.totals.total, money: true }],
    groups: [
      {
        kind: 'results',
        title,
        columns: cols,
        rows: data,
        align: ['left', 'right', 'right', 'right', 'right', 'right', 'right'],
        money: [false, true, true, true, true, true, true],
      },
    ],
  }
}

export function cashFlowExportData(
  cf: {
    sections: { section: string; lines: { type: string; label: string; amount: ExactDecimal }[]; subtotal: ExactDecimal }[]
    netChange: ExactDecimal
    openingCash: ExactDecimal
    closingCash: ExactDecimal
  },
  from: string,
  to: string,
  t: Translator,
): ExportData {
  const sectionLabel = (s: string) =>
    t(`cashFlow.sections.${s}`)
  const groups: ExportTableGroup[] = cf.sections.map((s) => {
    const label = sectionLabel(s.section)
    return {
      kind: 'section',
      title: label,
      columns: [t('export.columns.type'), t('export.columns.amount')],
      rows: [
        ...s.lines.map((l) => [l.label, l.amount] as (string | number)[]),
        [t('cashFlow.subtotal', { section: label }), s.subtotal] as (string | number)[],
      ],
      align: ['left', 'right'],
      money: [false, true],
    }
  })
  return {
    title: t('cashFlow.title'),
    dateRangeLabel: t('cashFlow.dateRange', { from, to }),
    summary: [
      { label: t('cashFlow.openingCash'), value: cf.openingCash, money: true },
      { label: t('cashFlow.netChange'), value: cf.netChange, money: true },
      { label: t('cashFlow.closingCash'), value: cf.closingCash, money: true },
    ],
    groups,
  }
}

export function cashFlowIndirectExportData(
  cf: {
    netIncome: ExactDecimal
    adjustments: { key: string; label?: string; amount: ExactDecimal }[]
    workingCapital: { name: string; number: string | null; amount: ExactDecimal }[]
    operating: ExactDecimal
    investing: { name: string; number: string | null; amount: ExactDecimal }[]
    investingTotal: ExactDecimal
    financing: { name: string; number: string | null; amount: ExactDecimal }[]
    financingTotal: ExactDecimal
    fxEffectOnCash: ExactDecimal
    netChange: ExactDecimal
    openingCash: ExactDecimal
    closingCash: ExactDecimal
  },
  from: string,
  to: string,
  t: Translator,
): ExportData {
  const line = (l: { name: string; number: string | null; amount: ExactDecimal }) =>
    [`${l.number ? `${l.number} · ` : ''}${l.name}`, l.amount] as (string | number)[]
  const groups: ExportTableGroup[] = [
    {
      kind: 'section',
      title: t('cashFlowIndirect.sections.operating'),
      columns: [t('export.columns.accountName'), t('export.columns.amount')],
      rows: [
        [t('cashFlowIndirect.netIncome'), cf.netIncome],
        ...cf.adjustments.map((a) => [a.label ?? t(`cashFlowIndirect.adjustments.${a.key}`), a.amount] as (string | number)[]),
        ...cf.workingCapital.map(line),
        [t('cashFlowIndirect.subtotals.operating'), cf.operating],
      ],
      align: ['left', 'right'],
      money: [false, true],
    },
    {
      kind: 'section',
      title: t('cashFlowIndirect.sections.investing'),
      columns: [t('export.columns.accountName'), t('export.columns.amount')],
      rows: [...cf.investing.map(line), [t('cashFlowIndirect.subtotals.investing'), cf.investingTotal]],
      align: ['left', 'right'],
      money: [false, true],
    },
    {
      kind: 'section',
      title: t('cashFlowIndirect.sections.financing'),
      columns: [t('export.columns.accountName'), t('export.columns.amount')],
      rows: [
        ...cf.financing.map(line),
        ...(decimalIsMaterial(cf.fxEffectOnCash)
          ? [[t('cashFlowIndirect.fxEffect'), cf.fxEffectOnCash] as (string | number)[]]
          : []),
        [t('cashFlowIndirect.subtotals.financing'), cf.financingTotal],
      ],
      align: ['left', 'right'],
      money: [false, true],
    },
  ]
  return {
    title: t('cashFlowIndirect.title'),
    dateRangeLabel: t('cashFlowIndirect.dateRange', { from, to }),
    summary: [
      { label: t('cashFlowIndirect.openingCash'), value: cf.openingCash, money: true },
      { label: t('cashFlowIndirect.netChange'), value: cf.netChange, money: true },
      { label: t('cashFlowIndirect.closingCash'), value: cf.closingCash, money: true },
    ],
    groups,
  }
}

// --- multi-column statement view (P&L / Balance Sheet) ----------------------
// The new matrix engine produces a StatementView (columns + typed lines). These
// adapters render it as a professional statement PDF, and flatten it for the
// existing XLSX/CSV pipeline.

function scaleForExport(scale: 'actual' | 'thousands' | 'millions'): { divisor: number; note: string } {
  if (scale === 'thousands') return { divisor: 1000, note: 'In thousands' }
  if (scale === 'millions') return { divisor: 1_000_000, note: 'In millions' }
  return { divisor: 1, note: '' }
}

/** Render a StatementView to a professional statement PDF Buffer. */
export async function renderStatementViewPdf(
  view: StatementView,
  branding: PdfBranding & { reportPdfStyle: StatementPdfStyle; baseCurrency: string },
  page: PdfPageSetup,
  opts: {
    title: string
    periodPhrase: string
    scale: 'actual' | 'thousands' | 'millions'
    generatedAt?: Date
  },
): Promise<Buffer> {
  const { divisor, note } = scaleForExport(opts.scale)
  const locale = await resolveLocale()
  return renderStatementPdf({
    companyName: branding.orgName,
    title: opts.title,
    periodPhrase: opts.periodPhrase,
    scaleNote: note || undefined,
    decimals: divisor === 1 ? undefined : 0,
    locale,
    currency: branding.baseCurrency,
    columns: view.columns.map((c) => ({ label: c.group ? `${c.group} · ${c.label}` : c.label, kind: c.kind })),
    rows: view.lines.map((l) => ({
      kind: l.kind,
      label: l.label,
      indent: l.kind === 'account' ? l.depth : 0,
      values: l.values?.map((v, i) => (view.columns[i]!.kind === 'variance_pct' ? v ?? null : v == null ? null : decimalScale(v, divisor))),
    })),
    style: branding.reportPdfStyle,
    branding,
    page,
    generatedAt: opts.generatedAt ?? new Date(),
    footnote: divisor !== 1 ? 'Amounts are rounded; columns may not sum exactly.' : undefined,
  })
}

/** A StatementView → a properly-formatted statement .xlsx: real cell
 *  indentation, bold section/subtotal/total rows with rules, accounting number
 *  formats. Numbers stay raw (unscaled) — a spreadsheet wants real figures. */
export async function statementViewToXlsx(
  view: StatementView,
  opts: { company: string; title: string; periodPhrase: string; accountLabel: string; note?: string; generatedAt?: Date },
): Promise<Buffer> {
  return statementSheetToXlsx({
    company: opts.company,
    title: opts.title,
    periodPhrase: opts.periodPhrase,
    note: opts.note,
    accountLabel: opts.accountLabel,
    columns: view.columns.map((c) => ({ label: c.group ? `${c.group} · ${c.label}` : c.label, kind: c.kind })),
    rows: view.lines.map((l) => ({
      kind: l.kind,
      label: l.label,
      indent: l.depth,
      values: l.values?.map((v) => v ?? null),
    })),
  }, { generatedAt: opts.generatedAt })
}

/** Flatten a StatementView into ExportData (one table) for XLSX/CSV. Amount
 *  columns are flagged money and keep their exact decimal strings; the account
 *  column is indented to preserve hierarchy. */
export function statementViewToExportData(
  view: StatementView,
  opts: { title: string; dateRangeLabel: string; accountLabel: string },
): ExportData {
  const columns = [opts.accountLabel, ...view.columns.map((c) => (c.group ? `${c.group} · ${c.label}` : c.label))]
  const rows: (string | number | null)[][] = view.lines.map((l) => {
    const label = l.kind === 'account' ? `${indent(l.depth)}${l.label}` : l.label
    if (!l.values) return [label, ...view.columns.map(() => null)]
    return [label, ...l.values.map((v) => v ?? null)]
  })
  return {
    title: opts.title,
    dateRangeLabel: opts.dateRangeLabel,
    summary: [],
    groups: [
      {
        kind: 'results',
        title: opts.title,
        columns,
        rows,
        align: ['left', ...view.columns.map(() => 'right' as PdfColumnAlign)],
        money: [false, ...view.columns.map((c) => c.kind !== 'variance_pct')],
      },
    ],
  }
}

// --- detail-report adapters (General Ledger, Journal, Registers, Statement) --

import type {
  JournalReportResult,
  RegisterResult,
  PartnerStatementResult,
} from './reports'

export function journalExportData(j: JournalReportResult, title: string, t: Translator): ExportData {
  const columns = [
    t('generalLedger.columns.entry'),
    t('generalLedger.columns.date'),
    t('export.columns.accountName'),
    t('journal.columns.detail'),
    t('trialBalance.columns.debits'),
    t('trialBalance.columns.credits'),
  ]
  const rows: (string | number | null)[][] = []
  for (const e of j.entries) {
    for (const l of e.lines) {
      rows.push([e.entryNumber ?? '', e.date, `${l.accountNumber ?? ''} ${l.accountName}`.trim(), [l.party, l.memo].filter(Boolean).join(' · '), decimalIsZero(l.debit) ? null : l.debit, decimalIsZero(l.credit) ? null : l.credit])
    }
  }
  return { title, dateRangeLabel: t('pnl.dateRange', { from: j.from, to: j.to }), summary: [], groups: [{ kind: 'results', title, columns, rows, align: ['left', 'left', 'left', 'left', 'right', 'right'], money: [false, false, false, false, true, true] }] }
}

export function registerExportData(reg: RegisterResult, title: string, t: Translator): ExportData {
  const columns = [
    t('export.columns.party'),
    t('generalLedger.columns.date'),
    t('generalLedger.columns.entry'),
    t('trialBalance.columns.debits'),
    t('trialBalance.columns.credits'),
    t('export.columns.balance'),
  ]
  const rows: (string | number | null)[][] = []
  for (const pt of reg.parties) {
    const name = pt.partyName ?? '—'
    rows.push([name, '', t('generalLedger.opening'), null, null, pt.opening])
    for (const l of pt.lines) rows.push([name, l.date, l.entryNumber ?? '', decimalIsZero(l.debit) ? null : l.debit, decimalIsZero(l.credit) ? null : l.credit, l.balance])
    rows.push([name, '', t('registers.closing'), null, null, pt.closing])
  }
  return { title, dateRangeLabel: t('pnl.dateRange', { from: reg.from, to: reg.to }), summary: [], groups: [{ kind: 'results', title, columns, rows, align: ['left', 'left', 'left', 'right', 'right', 'right'], money: [false, false, false, true, true, true] }] }
}

export function partnerStatementExportData(st: PartnerStatementResult, t: Translator): ExportData {
  const title = st.party.name ?? t('statements.title')
  const columns = [
    t('generalLedger.columns.date'),
    t('generalLedger.columns.entry'),
    t('trialBalance.columns.debits'),
    t('trialBalance.columns.credits'),
    t('export.columns.balance'),
  ]
  const rows: (string | number | null)[][] = [['', t('statements.opening'), null, null, st.opening]]
  for (const l of st.lines) rows.push([l.date, l.entryNumber ?? '', decimalIsZero(l.debit) ? null : l.debit, decimalIsZero(l.credit) ? null : l.credit, l.balance])
  rows.push(['', t('statements.closing'), null, null, st.closing])
  return {
    title,
    dateRangeLabel: t('pnl.dateRange', { from: st.from, to: st.to }),
    summary: [
      { label: t('aging.buckets.current'), value: st.aging.current, money: true },
      { label: t('aging.buckets.b1'), value: st.aging.b1, money: true },
      { label: t('aging.buckets.b2'), value: st.aging.b2, money: true },
      { label: t('aging.buckets.b3'), value: st.aging.b3, money: true },
      { label: t('aging.buckets.b4'), value: st.aging.b4, money: true },
      { label: t('aging.columns.total'), value: st.aging.total, money: true },
    ],
    groups: [{ kind: 'results', title, columns, rows, align: ['left', 'left', 'right', 'right', 'right'], money: [false, false, true, true, true] }],
  }
}

// Re-export the run-result label bridge so the export route can localize CSV.
export type { ReportRunLabels }

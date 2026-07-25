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
import { decimalScale } from './statement-format'
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

/**
 * Export pipeline for reports: a single intermediate shape (ExportData) feeds
 * PDF, Excel and CSV. Custom reports arrive as a ReportRunResult (numbers
 * preserved for Excel); financial statements are shaped by the adapters below.
 *
 * PDF numbers are formatted (thousands separators); Excel/CSV keep raw numbers
 * so Excel can apply its own number formatting and right-align them.
 */

export type Translator = (key: string, values?: Record<string, string | number>) => string

export type ExportData = {
  title: string
  dateRangeLabel: string
  summary: ReportSummaryItem[]
  groups: PdfTableGroup[]
}

// --- branding ---------------------------------------------------------------

export async function orgBranding(orgId?: string): Promise<PdfBranding & { reportPdfStyle: StatementPdfStyle; baseCurrency: string }> {
  const activeOrgId = await resolveOrgId(orgId)
  const r = (await db.execute(sql`
    select name, base_currency,
           settings ->> 'brandPrimary' as brand_primary,
           settings ->> 'reportPdfStyle' as report_pdf_style
      from orgs
     where id = ${activeOrgId}
  `)) as unknown as { rows: { name: string; base_currency: string; brand_primary: string | null; report_pdf_style: string | null }[] }
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

function pdfCell(v: string | number | null | undefined, locale: string): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'number') return pdfNum(v, locale)
  return String(v)
}

function pdfSummary(s: ReportSummaryItem, locale: string): { label: string; value: string } {
  return {
    label: s.label,
    value: typeof s.value === 'number' ? pdfNum(s.value, locale) : String(s.value),
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
      align: undefined,
      isEmpty: g.isEmpty,
    })),
  }
}

/** ExportData → ReportRunResult (numbers preserved) for Excel/CSV. */
export function exportDataToRunResult(data: ExportData): ReportRunResult {
  const groups: ReportGroup[] = data.groups.map((g) => ({
    kind: g.kind,
    title: g.title,
    subtitle: g.subtitle,
    columns: g.columns,
    rows: g.rows,
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
    rows: g.rows.map((row) => row.map((cell) => pdfCell(cell, locale))),
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

export async function exportDataToPdf(data: ExportData, branding: PdfBranding, page: PdfPageSetup, opts?: { showSummary?: boolean }): Promise<Buffer> {
  const locale = await resolveLocale()
  return renderPdfDocument(exportDataToPdfInput(data, branding, page, { ...opts, locale }))
}

export async function exportDataToXlsx(data: ExportData, opts: { reportName: string; dateRangeLabel?: string }): Promise<Buffer> {
  return reportResultToXlsx(exportDataToRunResult(data), opts)
}

export function exportDataToCsv(data: ExportData, opts: { sectionHeader?: string }): string {
  return reportResultToCsv(exportDataToRunResult(data), opts)
}

// --- financial-statement adapters ------------------------------------------
// Each returns an ExportData with numeric cells (so Excel stays numeric).
// Section/group titles and column headers come through the reports translator
// (keys under reports.* — see web/messages/<locale>/reports.json).

type StatementRow = {
  id: string
  number: string | null
  name: string
  type: string
  balance: number
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
  total: number,
): PdfTableGroup {
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
  }
}

export function pnlExportData(
  pl: { items: StatementRow[]; revenue: number; cogs: number; grossProfit: number; expenses: number; netIncome: number },
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
      { label: revenueTitle, value: pl.revenue },
      { label: t('pnl.grossProfit'), value: pl.grossProfit },
      { label: t('pnl.netIncome'), value: pl.netIncome },
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
      },
    ],
  }
}

export function balanceSheetExportData(
  bs: { assets: StatementRow[]; liabilities: StatementRow[]; equity: StatementRow[]; totalAssets: number; totalLiabilities: number; totalEquity: number },
  asOf: string,
  t: Translator,
): ExportData {
  const assetsTitle = t('balanceSheet.assets')
  const liabTitle = t('balanceSheet.liabilities')
  const equityTitle = t('balanceSheet.equity')
  const groupFor = (title: string, items: StatementRow[], total: number) =>
    statementGroup(t, title, title, items, items.map((i) => i.type), total)
  return {
    title: t('balanceSheet.title'),
    dateRangeLabel: t('balanceSheet.asOf', { date: asOf }),
    summary: [
      { label: assetsTitle, value: bs.totalAssets },
      { label: liabTitle, value: bs.totalLiabilities },
      { label: equityTitle, value: bs.totalEquity },
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
      revenue: number; cogs: number; grossProfit: number; expenses: number; net: number; margin: number | null; hours: number
    }[]
    customers: {
      customerName: string | null
      rows: {
        projectName: string
        revenue: number; cogs: number; grossProfit: number; expenses: number; net: number; margin: number | null; hours: number
      }[]
      totals: { revenue: number; cogs: number; grossProfit: number; expenses: number; net: number; margin: number | null; hours: number }
    }[]
    totals: { revenue: number; cogs: number; grossProfit: number; expenses: number; net: number; margin: number | null; hours: number }
    from: string
    to: string
  },
  t: Translator,
): ExportData {
  const pct = (m: number | null) => (m === null ? '' : `${(m * 100).toFixed(1)}%`)
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
      { label: t('projectProfitability.columns.revenue'), value: result.totals.revenue },
      { label: t('projectProfitability.columns.net'), value: result.totals.net },
    ],
    groups: [
      {
        kind: 'results',
        title: t('projectProfitability.title'),
        columns: cols,
        rows: data,
        align: ['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right'],
      },
    ],
  }
}

export function trialBalanceExportData(
  rows: { number: string | null; name: string; type: string; debits: string; credits: string; balance: string }[],
  asOf: string,
  t: Translator,
): ExportData {
  const num = (s: string) => Number(s)
  const data = rows.map((r) => [r.number ?? '', r.name, num(r.debits), num(r.credits), num(r.balance)] as (string | number)[])
  const totalDebits = rows.reduce((a, r) => a + num(r.debits), 0)
  const totalCredits = rows.reduce((a, r) => a + num(r.credits), 0)
  const totalBalance = rows.reduce((a, r) => a + num(r.balance), 0)
  data.push(['', t('trialBalance.totals'), totalDebits, totalCredits, totalBalance])
  return {
    title: t('trialBalance.title'),
    dateRangeLabel: t('trialBalance.description', { date: asOf, count: rows.length }),
    summary: [
      { label: t('trialBalance.columns.debits'), value: totalDebits },
      { label: t('trialBalance.columns.credits'), value: totalCredits },
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
  const total = rows.reduce((a, r) => a + Number(r.balance), 0)
  const data = rows.map((r) => [
    r.display_name ?? t('partners.noPartyOnLines'),
    Number(r.balance),
    Number(r.line_count),
    r.latest_due ?? '',
  ] as (string | number)[])
  return {
    title,
    dateRangeLabel: t('partners.description'),
    summary: [
      { label: t('partners.totalOutstanding'), value: total },
      { label: t('partners.partiesWithBalance'), value: rows.length },
    ],
    groups: [
      {
        kind: 'results',
        title,
        columns: [t('export.columns.party'), t('partners.columns.outstanding'), t('partners.columns.glLines'), t('export.columns.latestDue')],
        rows: data,
        align: ['left', 'right', 'right', 'left'],
      },
    ],
  }
}

export function agingExportData(
  side: 'ar' | 'ap',
  result: {
    rows: { partyName: string | null; current: number; b1: number; b2: number; b3: number; b4: number; total: number }[]
    totals: { current: number; b1: number; b2: number; b3: number; b4: number; total: number }
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
    summary: [{ label: t('aging.columns.total'), value: result.totals.total }],
    groups: [
      {
        kind: 'results',
        title,
        columns: cols,
        rows: data,
        align: ['left', 'right', 'right', 'right', 'right', 'right', 'right'],
      },
    ],
  }
}

export function cashFlowExportData(
  cf: {
    sections: { section: string; lines: { type: string; label: string; amount: number }[]; subtotal: number }[]
    netChange: number
    openingCash: number
    closingCash: number
  },
  from: string,
  to: string,
  t: Translator,
): ExportData {
  const sectionLabel = (s: string) =>
    t(`cashFlow.sections.${s}`)
  const groups: PdfTableGroup[] = cf.sections.map((s) => {
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
    }
  })
  return {
    title: t('cashFlow.title'),
    dateRangeLabel: t('cashFlow.dateRange', { from, to }),
    summary: [
      { label: t('cashFlow.openingCash'), value: cf.openingCash },
      { label: t('cashFlow.netChange'), value: cf.netChange },
      { label: t('cashFlow.closingCash'), value: cf.closingCash },
    ],
    groups,
  }
}

export function cashFlowIndirectExportData(
  cf: {
    netIncome: number
    adjustments: { key: string; label?: string; amount: number }[]
    workingCapital: { name: string; number: string | null; amount: number }[]
    operating: number
    investing: { name: string; number: string | null; amount: number }[]
    investingTotal: number
    financing: { name: string; number: string | null; amount: number }[]
    financingTotal: number
    fxEffectOnCash: number
    netChange: number
    openingCash: number
    closingCash: number
  },
  from: string,
  to: string,
  t: Translator,
): ExportData {
  const line = (l: { name: string; number: string | null; amount: number }) =>
    [`${l.number ? `${l.number} · ` : ''}${l.name}`, l.amount] as (string | number)[]
  const groups: PdfTableGroup[] = [
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
    },
    {
      kind: 'section',
      title: t('cashFlowIndirect.sections.investing'),
      columns: [t('export.columns.accountName'), t('export.columns.amount')],
      rows: [...cf.investing.map(line), [t('cashFlowIndirect.subtotals.investing'), cf.investingTotal]],
      align: ['left', 'right'],
    },
    {
      kind: 'section',
      title: t('cashFlowIndirect.sections.financing'),
      columns: [t('export.columns.accountName'), t('export.columns.amount')],
      rows: [
        ...cf.financing.map(line),
        ...(Math.abs(cf.fxEffectOnCash) >= 0.005
          ? [[t('cashFlowIndirect.fxEffect'), cf.fxEffectOnCash] as (string | number)[]]
          : []),
        [t('cashFlowIndirect.subtotals.financing'), cf.financingTotal],
      ],
      align: ['left', 'right'],
    },
  ]
  return {
    title: t('cashFlowIndirect.title'),
    dateRangeLabel: t('cashFlowIndirect.dateRange', { from, to }),
    summary: [
      { label: t('cashFlowIndirect.openingCash'), value: cf.openingCash },
      { label: t('cashFlowIndirect.netChange'), value: cf.netChange },
      { label: t('cashFlowIndirect.closingCash'), value: cf.closingCash },
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
  opts: { company: string; title: string; periodPhrase: string; accountLabel: string; note?: string },
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
  })
}

/** Flatten a StatementView into ExportData (one table) for XLSX/CSV. Amounts
 *  stay numeric; the account column is indented to preserve hierarchy. */
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
      },
    ],
  }
}

// --- detail-report adapters (General Ledger, Journal, Registers, Statement) --

import type {
  GeneralLedgerResult,
  JournalReportResult,
  RegisterResult,
  PartnerStatementResult,
} from './reports'

const LEDGER_ALIGN: PdfColumnAlign[] = ['left', 'left', 'left', 'left', 'right', 'right', 'right']

export function generalLedgerExportData(gl: GeneralLedgerResult, title: string, t: Translator): ExportData {
  const columns = [
    t('export.columns.accountName'),
    t('generalLedger.columns.date'),
    t('generalLedger.columns.entry'),
    t('generalLedger.columns.detail'),
    t('trialBalance.columns.debits'),
    t('trialBalance.columns.credits'),
    t('export.columns.balance'),
  ]
  const rows: (string | number | null)[][] = []
  for (const a of gl.accounts) {
    const acct = `${a.number ?? ''} ${a.name}`.trim()
    rows.push([acct, '', '', t('generalLedger.opening'), null, null, a.opening])
    for (const l of a.lines) {
      rows.push([acct, l.date, l.entryNumber ?? '', [l.party, l.memo].filter(Boolean).join(' · '), l.debit || null, l.credit || null, l.balance])
    }
    rows.push([acct, '', '', t('generalLedger.closing'), null, null, a.closing])
  }
  return { title, dateRangeLabel: t('pnl.dateRange', { from: gl.from, to: gl.to }), summary: [], groups: [{ kind: 'results', title, columns, rows, align: LEDGER_ALIGN }] }
}

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
      rows.push([e.entryNumber ?? '', e.date, `${l.accountNumber ?? ''} ${l.accountName}`.trim(), [l.party, l.memo].filter(Boolean).join(' · '), l.debit || null, l.credit || null])
    }
  }
  return { title, dateRangeLabel: t('pnl.dateRange', { from: j.from, to: j.to }), summary: [], groups: [{ kind: 'results', title, columns, rows, align: ['left', 'left', 'left', 'left', 'right', 'right'] }] }
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
    for (const l of pt.lines) rows.push([name, l.date, l.entryNumber ?? '', l.debit || null, l.credit || null, l.balance])
    rows.push([name, '', t('registers.closing'), null, null, pt.closing])
  }
  return { title, dateRangeLabel: t('pnl.dateRange', { from: reg.from, to: reg.to }), summary: [], groups: [{ kind: 'results', title, columns, rows, align: ['left', 'left', 'left', 'right', 'right', 'right'] }] }
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
  for (const l of st.lines) rows.push([l.date, l.entryNumber ?? '', l.debit || null, l.credit || null, l.balance])
  rows.push(['', t('statements.closing'), null, null, st.closing])
  return {
    title,
    dateRangeLabel: t('pnl.dateRange', { from: st.from, to: st.to }),
    summary: [
      { label: t('aging.buckets.current'), value: st.aging.current },
      { label: t('aging.buckets.b1'), value: st.aging.b1 },
      { label: t('aging.buckets.b2'), value: st.aging.b2 },
      { label: t('aging.buckets.b3'), value: st.aging.b3 },
      { label: t('aging.buckets.b4'), value: st.aging.b4 },
      { label: t('aging.columns.total'), value: st.aging.total },
    ],
    groups: [{ kind: 'results', title, columns, rows, align: ['left', 'left', 'right', 'right', 'right'] }],
  }
}

// Re-export the run-result label bridge so the export route can localize CSV.
export type { ReportRunLabels }

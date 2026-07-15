import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import {
  renderPdfDocument,
  resolvePdfPageSetup,
  type PdfBranding,
  type PdfColumnAlign,
  type PdfDocumentInput,
  type PdfPageSetup,
  type PdfTableGroup,
} from '@openbooks/pdf'
import {
  reportResultToXlsx,
  reportResultToCsv,
  type ReportRunResult,
} from '@openbooks/office'
import type {
  ReportGroup,
  ReportLayoutConfig,
  ReportRunLabels,
  ReportSummaryItem,
} from '@openbooks/reports'
import { resolveReportLayout } from '@openbooks/reports'
import { money } from './format'

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

export async function orgBranding(): Promise<PdfBranding> {
  const r = (await db.execute(sql`
    select name,
           (select settings ->> 'brandPrimary' from orgs o2 limit 1) as brand_primary
      from orgs limit 1
  `)) as unknown as { rows: { name: string; brand_primary: string | null }[] }
  const row = r.rows[0]
  return {
    orgName: row?.name ?? 'openbooks',
    primaryColor: row?.brand_primary || null,
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
export function pdfNum(v: number): string {
  return Number.isInteger(v) ? v.toLocaleString('en-CA') : money(v)
}

function pdfCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'number') return pdfNum(v)
  return String(v)
}

function pdfSummary(s: ReportSummaryItem): { label: string; value: string } {
  return {
    label: s.label,
    value: typeof s.value === 'number' ? pdfNum(s.value) : String(s.value),
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
  opts: { showSummary?: boolean; generatedAt?: Date; footerLeft?: string } = {},
): PdfDocumentInput {
  const groups: PdfTableGroup[] = data.groups.map((g) => ({
    kind: g.kind,
    title: g.title,
    subtitle: g.subtitle,
    columns: g.columns,
    rows: g.rows.map((row) => row.map(pdfCell)),
    align: g.align,
    isEmpty: g.isEmpty,
  }))
  return {
    title: data.title,
    dateRangeLabel: data.dateRangeLabel,
    generatedAt: opts.generatedAt ?? new Date(),
    branding,
    summary: opts.showSummary === false ? undefined : data.summary.map(pdfSummary),
    groups,
    layout: page,
    footerLeft: opts.footerLeft,
  }
}

export async function exportDataToPdf(data: ExportData, branding: PdfBranding, page: PdfPageSetup, opts?: { showSummary?: boolean }): Promise<Buffer> {
  return renderPdfDocument(exportDataToPdfInput(data, branding, page, opts))
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

// Re-export the run-result label bridge so the export route can localize CSV.
export type { ReportRunLabels }

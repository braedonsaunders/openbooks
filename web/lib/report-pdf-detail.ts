import type { PdfColumnAlign, PdfTableGroup } from '@openbooks/pdf'
import type { GeneralLedgerResult } from './reports'
import type { ExportData, Translator } from './report-pdf'
import type { ExactDecimal } from './statement-format'
import { decimalIsZero } from './statement-format'

const LEDGER_ALIGN: PdfColumnAlign[] = ['left', 'left', 'left', 'right', 'right', 'right']

// --- exact money cells -------------------------------------------------------
// Ledger decimals arrive as exact numeric(19,4) STRINGS. Coercing them through
// IEEE-754 doubles silently loses precision past 2^53 (~15.95 digits), so a
// printed PDF could disagree with the ledger by real money. Money columns are
// therefore marked per group (`money`, mirroring ReportGroup.money) and their
// exact strings are handed straight to Intl, whose mathematical-value parsing
// never builds a double — the same discipline as web/lib/money-format.ts and
// @openbooks/pdf's statement renderer ("binary floating point is only ever
// touched at the very end"). A ledger decimal becomes a double exactly once,
// at the spreadsheet boundary in exportDataToRunResult, because .xlsx stores
// IEEE-754 doubles natively; print never does.

const EXACT_DECIMAL_TEXT = /^[-+]?\d+(?:\.\d+)?$/
const NEGATIVE_ZERO_TEXT = /^-0(?:\.0*)?$/

/** True when a cell is an exact decimal literal (a ledger string), safe to
 *  hand to Intl as a mathematical value. */
export function isExactDecimalText(v: string): boolean {
  return EXACT_DECIMAL_TEXT.test(v)
}

/** Format one exact ledger decimal for print: thousands separators and two
 *  fraction digits with no IEEE-754 round-trip (`2.675` really rounds to
 *  `2.68`). Non-numeric text renders raw — presentation mirrors
 *  createMoneyFormatter's fallback for non-numeric cells. */
export function pdfMoney(v: ExactDecimal, locale = 'en'): string {
  if (!EXACT_DECIMAL_TEXT.test(v)) return v
  // Collapse "-0"/"-0.0000" so a zeroed account never prints "-0.00".
  const normalized = NEGATIVE_ZERO_TEXT.test(v) ? '0' : v
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(normalized as never)
}

/**
 * Preserve the on-screen General Ledger's paper hierarchy in every export:
 * each account owns a section and its lines no longer waste a narrow repeated
 * account column. The resulting six-column table is both more legible on paper
 * and self-describing when a section continues on another page.
 */
export function generalLedgerExportData(
  gl: GeneralLedgerResult,
  title: string,
  t: Translator,
): ExportData {
  const columns = [
    t('generalLedger.columns.date'),
    t('generalLedger.columns.entry'),
    t('generalLedger.columns.detail'),
    t('trialBalance.columns.debits'),
    t('trialBalance.columns.credits'),
    t('export.columns.balance'),
  ]
  const groups: PdfTableGroup[] = gl.accounts.map((account) => ({
    kind: 'section',
    title: `${account.number ?? ''} ${account.name}`.trim(),
    columns,
    rows: [
      ['', '', t('generalLedger.opening'), null, null, Number(account.opening)],
      ...account.lines.map((line) => [
        line.date,
        line.entryNumber ?? '',
        [line.party, line.memo].filter(Boolean).join(' · '),
        decimalIsZero(line.debit) ? null : Number(line.debit),
        decimalIsZero(line.credit) ? null : Number(line.credit),
        Number(line.balance),
      ]),
      ['', '', t('generalLedger.closing'), null, null, Number(account.closing)],
    ],
    // Money columns are marked so consumers can tell amounts from text. The
    // cells stay numeric: the on-screen General Ledger paper renderer
    // (general-ledger-paper.ts) formats only `typeof cell === "number"` cells.
    money: [false, false, false, true, true, true],
    align: LEDGER_ALIGN,
  }))
  return {
    title,
    dateRangeLabel: t('pnl.dateRange', { from: gl.from, to: gl.to }),
    summary: [],
    groups,
  }
}

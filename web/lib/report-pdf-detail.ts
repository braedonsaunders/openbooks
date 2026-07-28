import type { PdfColumnAlign, PdfTableGroup } from '@openbooks/pdf'
import type { GeneralLedgerResult } from './reports'
import type { ExportData, Translator } from './report-pdf'

const LEDGER_ALIGN: PdfColumnAlign[] = ['left', 'left', 'left', 'right', 'right', 'right']

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
      ['', '', t('generalLedger.opening'), null, null, account.opening],
      ...account.lines.map((line) => [
        line.date,
        line.entryNumber ?? '',
        [line.party, line.memo].filter(Boolean).join(' · '),
        line.debit || null,
        line.credit || null,
        line.balance,
      ]),
      ['', '', t('generalLedger.closing'), null, null, account.closing],
    ],
    align: LEDGER_ALIGN,
  }))
  return {
    title,
    dateRangeLabel: t('pnl.dateRange', { from: gl.from, to: gl.to }),
    summary: [],
    groups,
  }
}

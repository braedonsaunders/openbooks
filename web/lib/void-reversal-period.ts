'use client'

import { promptDialog } from './prompt'

export type VoidReversalPeriodCopy = {
  title: string
  /** Label above the reversal-date input. */
  dateLabel: string
  /** "Original entry" — prefixes the entry's date in the summary. */
  summaryOriginal: string
  /** "Reversal" — prefixes the suggested date in the summary. */
  summaryReversal: string
  /** Fiscal-year abbreviation shown as "FY 2026". */
  fiscalYear: string
  /** Shown when the entry's period closed and the default moved forward. */
  fallbackNotice: string
  /** Shown when no open period follows the entry's period. */
  closedNotice: string
  label: string
  regularOption: string
  confirm: string
  cancel: string
}

export type VoidReversalPeriodChoice = {
  cancelled: boolean
  reversalDate: string | null
  reversalPeriodId: string | null
}

type AdjustmentPeriod = {
  id: string
  name: string
  startsOn: string
  endsOn: string
}

export type VoidReversalSuggestion = {
  originalDate: string
  suggestedDate: string
  fallbackToOpenPeriod: boolean
  originalFiscalYear: number | null
  originalPeriodName: string | null
  suggestedFiscalYear: number | null
  suggestedPeriodName: string | null
  suggestedOpen: boolean
}

/**
 * One YYYY-MM-DD line for the dialog summary: the date with its fiscal year
 * when the server resolved one ("2025-10-31 (FY 2026)"), the bare date when
 * no covering period exists.
 */
export function formatReversalSummaryLine(
  label: string,
  date: string,
  fiscalYear: number | null,
  fiscalYearLabel: string,
): string {
  return fiscalYear == null ? `${label}: ${date}` : `${label}: ${date} (${fiscalYearLabel} ${fiscalYear})`
}

/**
 * The dialog message confirming a void reversal: both dates with their
 * fiscal years, plus the closed-period fallback notice when the default
 * moved forward — or the no-open-period warning when nothing follows.
 */
export function formatReversalSummary(
  copy: Pick<VoidReversalPeriodCopy, 'summaryOriginal' | 'summaryReversal' | 'fiscalYear' | 'fallbackNotice' | 'closedNotice'>,
  suggestion: VoidReversalSuggestion,
): string {
  const parts = [
    formatReversalSummaryLine(copy.summaryOriginal, suggestion.originalDate, suggestion.originalFiscalYear, copy.fiscalYear),
    formatReversalSummaryLine(copy.summaryReversal, suggestion.suggestedDate, suggestion.suggestedFiscalYear, copy.fiscalYear),
  ]
  if (suggestion.fallbackToOpenPeriod) parts.push(copy.fallbackNotice)
  else if (!suggestion.suggestedOpen) parts.push(copy.closedNotice)
  return parts.join(' · ')
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Confirm a void reversal with its date. The dialog always shows the entry's
 * date beside the reversal date with both fiscal years, so a prior-period
 * void can never slip into the wrong year unseen; the date input arrives
 * prefilled with the server suggestion and the operator may change it. An
 * adjustment-period override keeps its second choice when the org uses
 * adjustment periods. Resolves cancelled only on dismiss. A failed lookup
 * falls back to the server default instead of blocking the void: the void
 * POST itself validates any named date, so proceeding only ever reproduces
 * the server-side default.
 */
export async function promptVoidReversalPeriod(
  documentId: string,
  copy: VoidReversalPeriodCopy,
): Promise<VoidReversalPeriodChoice> {
  let periods: AdjustmentPeriod[] = []
  let suggestion: VoidReversalSuggestion | null = null
  try {
    const res = await fetch(`/api/documents/${documentId}/void`)
    if (res.ok) {
      const data = (await res.json().catch(() => null)) as {
        adjustmentPeriods?: unknown
      } & Partial<VoidReversalSuggestion> | null
      if (data && Array.isArray(data.adjustmentPeriods)) {
        periods = (data.adjustmentPeriods as Partial<AdjustmentPeriod>[]).filter(
          (period): period is AdjustmentPeriod =>
            !!period && typeof period.id === 'string' && typeof period.name === 'string',
        )
      }
      if (data && typeof data.originalDate === 'string' && typeof data.suggestedDate === 'string') {
        suggestion = {
          originalDate: data.originalDate,
          suggestedDate: data.suggestedDate,
          fallbackToOpenPeriod: data.fallbackToOpenPeriod === true,
          originalFiscalYear: typeof data.originalFiscalYear === 'number' ? data.originalFiscalYear : null,
          originalPeriodName: typeof data.originalPeriodName === 'string' ? data.originalPeriodName : null,
          suggestedFiscalYear: typeof data.suggestedFiscalYear === 'number' ? data.suggestedFiscalYear : null,
          suggestedPeriodName: typeof data.suggestedPeriodName === 'string' ? data.suggestedPeriodName : null,
          suggestedOpen: data.suggestedOpen === true,
        }
      }
    }
  } catch {
    periods = []
  }
  if (!suggestion) return { cancelled: false, reversalDate: null, reversalPeriodId: null }
  let reversalDate = suggestion.suggestedDate
  for (;;) {
    const chosen = await promptDialog({
      title: copy.title,
      message: formatReversalSummary(copy, { ...suggestion, suggestedDate: reversalDate }),
      label: copy.dateLabel,
      initialValue: reversalDate,
      confirmLabel: copy.confirm,
      cancelLabel: copy.cancel,
    })
    if (chosen === null) return { cancelled: true, reversalDate: null, reversalPeriodId: null }
    if (ISO_DATE.test(chosen)) {
      reversalDate = chosen
      break
    }
    reversalDate = chosen
  }
  if (periods.length === 0) return { cancelled: false, reversalDate, reversalPeriodId: null }
  const period = await promptDialog({
    title: copy.title,
    label: copy.label,
    confirmLabel: copy.confirm,
    cancelLabel: copy.cancel,
    options: [
      { value: '', label: copy.regularOption },
      ...periods.map((entry) => ({ value: entry.id, label: entry.name })),
    ],
  })
  if (period === null) return { cancelled: true, reversalDate: null, reversalPeriodId: null }
  return { cancelled: false, reversalDate, reversalPeriodId: period || null }
}

// Presentation helpers for statement values — shared by the on-screen matrix
// table. Professional conventions: negatives in parentheses, a dash for zero,
// thousands separators, optional "in thousands / millions" scaling. (The PDF
// renderer has its own, stricter variant for currency-on-first-row rules.)

import type { ReportScale } from './report-filters'
import type { StatementColumnKind } from './statement-matrix'

const DASH = '–' // en dash

export function scaleDivisor(scale: ReportScale): number {
  return scale === 'thousands' ? 1000 : scale === 'millions' ? 1_000_000 : 1
}

/** Format a signed amount: parentheses for negatives, dash for ~zero. */
export function formatAmount(value: number, scale: ReportScale = 'actual'): string {
  const scaled = value / scaleDivisor(scale)
  const digits = scale === 'actual' ? 2 : 0
  if (Math.abs(scaled) < (digits === 0 ? 0.5 : 0.005)) return DASH
  const abs = Math.abs(scaled).toLocaleString('en-CA', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
  return scaled < 0 ? `(${abs})` : abs
}

/** Format a percentage variance; blank/dash when undefined (no prior base). */
export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return DASH
  return `${value.toFixed(1)}%`
}

/** Format one matrix cell by its column kind. */
export function formatCell(value: number, kind: StatementColumnKind, scale: ReportScale = 'actual'): string {
  if (kind === 'variance_pct') return formatPercent(value)
  return formatAmount(value, scale)
}

/** Whether a cell should read as "negative" for red-text styling. */
export function isNegative(value: number, kind: StatementColumnKind): boolean {
  if (kind === 'variance_pct') return Number.isFinite(value) && value < 0
  return value < -0.005
}

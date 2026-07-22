// Presentation helpers for statement values — shared by the on-screen matrix
// table. Professional conventions: negatives in parentheses, a dash for zero,
// thousands separators, optional "in thousands / millions" scaling. (The PDF
// renderer has its own, stricter variant for currency-on-first-row rules.)

import type { ReportScale } from './report-filters'
import type { StatementColumnKind } from './statement-matrix'

export function scaleDivisor(scale: ReportScale): number {
  return scale === 'thousands' ? 1000 : scale === 'millions' ? 1_000_000 : 1
}

/** Whether a cell should read as "negative" for red-text styling. */
export function isNegative(value: number, kind: StatementColumnKind): boolean {
  if (kind === 'variance_pct') return Number.isFinite(value) && value < 0
  return value < -0.005
}

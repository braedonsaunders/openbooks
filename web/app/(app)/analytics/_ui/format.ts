/** Client-side formatters for analytics screens. */

'use client'

import { useCallback } from 'react'
import { useLocale } from 'next-intl'
import { useMoney } from '@/components/money-provider'
import { formatMoney as formatExactMoney, mulDecimal, roundDiv, toUnits } from '@openbooks/engine/src/money/money.ts'
import type { MoneyValue } from '../../../../lib/money-format'

/** Format canonical ledger strings without coercing them through Number. */
export function useAnalyticsMoney(): (n: MoneyValue, options?: { compact?: boolean }) => string {
  const { money, moneyCompact } = useMoney()
  return useCallback(
    (n: MoneyValue, { compact = false }: { compact?: boolean } = {}) =>
      compact ? moneyCompact(n) : money(n, { maximumFractionDigits: 0 }),
    [money, moneyCompact],
  )
}

export { boundChartNumber, toChartNumber } from '../../../../lib/chart-number'

/** Presentation-only formatting for exact ratios. The ratio stays a string
 * through all comparisons; this helper rounds only when rendering text. */
export function formatExactRatio(value: string, decimals = 2): string {
  return formatExactMoney(value, decimals)
}

/**
 * Dimensionless ratio of two canonical decimal strings as a display number
 * (progress bars, chart domains). The quotient rounds once, to microunits,
 * from integer minor units — money never crosses into Number here. A zero
 * denominator yields the fallback (never null: callers keep their own guard).
 */
export function ratioNumber(numerator: string, denominator: string, fallback = 0): number {
  const scale = 1_000_000n
  const n = toUnits(numerator)
  const d = toUnits(denominator)
  if (d === 0n) return fallback
  const negative = (n < 0n) !== (d < 0n)
  const mag = roundDiv((n < 0n ? -n : n) * scale, d < 0n ? -d : d)
  return Number(negative ? -mag : mag) / Number(scale)
}

/** Escape a tenant-controlled name before inserting it into an ECharts HTML
 * tooltip string. ECharts writes formatter output via innerHTML, so a vendor,
 * customer, account, department, class, or location name containing markup
 * would execute as stored XSS. Money and percent fragments are
 * locale-formatted numbers and need no escaping — only names do. */
export function escapeTooltipHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Render an exact 0..1 ratio as percentage points without a Number hop. */
export function formatExactPercent(value: string, decimals = 0): string {
  return `${formatExactMoney(mulDecimal(value, '100'), decimals)}%`
}

export function fmtPct(n: number, decimals = 1): string {
  return `${(n * 100).toFixed(decimals)}%`
}

/**
 * Locale-aware display of an exact ratio value (a decimal string from the
 * Financial Health engine): fractions as percentages, multiples with a ×,
 * points as plain numbers, money in the organization's currency. Intl
 * formats the decimal string itself, so no Number hop decides the digits.
 */
export function useRatioFormat(): (value: string | null, format: 'pct' | 'times' | 'points' | 'money', compact?: boolean) => string | null {
  const fmtMoney = useAnalyticsMoney()
  const locale = useLocale()
  return useCallback((value, format, compact = true) => {
    if (value === null) return null
    const exact = value as unknown as number
    switch (format) {
      case 'pct':
        return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(exact)
      case 'times':
        return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(exact)}×`
      case 'points':
        return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(exact)
      case 'money':
        return fmtMoney(value, { compact })
    }
  }, [fmtMoney, locale])
}

/**
 * Tone bands for a 0–100 gauge: the score at or above each cut-off reads in
 * that tone. Every caller passes its own bands — the Financial Health
 * screens pass the configured score labels, anything without configured
 * bands passes the neutral presentation scale.
 */
export interface ScoreBands {
  excellent: number
  good: number
  average: number
}

/** Semantic colour for a health score / sub-score, 0–100. */
export function scoreTone(score: number, bands: ScoreBands): {
  hex: string
  text: string
  ring: string
} {
  if (score >= bands.excellent) return { hex: '#10b981', text: 'text-emerald-600 dark:text-emerald-400', ring: 'ring-emerald-500/20' }
  if (score >= bands.good) return { hex: '#0ea5b7', text: 'text-teal-600 dark:text-teal-400', ring: 'ring-teal-500/20' }
  if (score >= bands.average) return { hex: '#f59e0b', text: 'text-amber-600 dark:text-amber-400', ring: 'ring-amber-500/20' }
  return { hex: '#ef4444', text: 'text-red-600 dark:text-red-400', ring: 'ring-red-500/20' }
}

export const GRADE_STYLE: Record<string, string> = {
  A: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300',
  B: 'bg-teal-100 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300',
  C: 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300',
  D: 'bg-orange-100 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300',
  F: 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300',
}

/** Soft card tint by grade, used behind the ratio cards. */
export const GRADE_TINT: Record<string, string> = {
  A: 'bg-emerald-50/60 border-emerald-100 dark:bg-emerald-950/20 dark:border-emerald-900/40',
  B: 'bg-teal-50/60 border-teal-100 dark:bg-teal-950/20 dark:border-teal-900/40',
  C: 'bg-amber-50/60 border-amber-100 dark:bg-amber-950/20 dark:border-amber-900/40',
  D: 'bg-orange-50/60 border-orange-100 dark:bg-orange-950/20 dark:border-orange-900/40',
  F: 'bg-red-50/50 border-red-100 dark:bg-red-950/20 dark:border-red-900/40',
}

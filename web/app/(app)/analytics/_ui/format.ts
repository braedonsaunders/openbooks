/** Client-side formatters for analytics screens. */

'use client'

import { useCallback } from 'react'
import { useMoney } from '@/components/money-provider'

export function useAnalyticsMoney(): (n: number, options?: { compact?: boolean }) => string {
  const { money, moneyCompact } = useMoney()
  return useCallback(
    (n: number, { compact = false }: { compact?: boolean } = {}) =>
      compact ? moneyCompact(n) : money(n, { maximumFractionDigits: 0 }),
    [money, moneyCompact],
  )
}

export function fmtPct(n: number, decimals = 1): string {
  return `${(n * 100).toFixed(decimals)}%`
}

export function fmtNum(n: number, suffix = 'x'): string {
  return `${n.toFixed(2)}${suffix}`
}

export type ValueFormat = 'pct' | 'money' | 'num' | 'raw'

export function useAnalyticsValue(): (value: number | null, format: ValueFormat, compact?: boolean) => string {
  const fmtMoney = useAnalyticsMoney()
  return useCallback((value: number | null, format: ValueFormat, compact = true): string => {
    if (value === null || !isFinite(value)) return 'N/A'
    switch (format) {
      case 'pct':
        return fmtPct(value)
      case 'money':
        return fmtMoney(value, { compact })
      case 'num':
        return fmtNum(value)
      case 'raw':
        return value.toFixed(1)
    }
  }, [fmtMoney])
}

/** Semantic colour for a health score / sub-score, 0–100. */
export function scoreTone(score: number): {
  hex: string
  text: string
  ring: string
} {
  if (score >= 80) return { hex: '#10b981', text: 'text-emerald-600 dark:text-emerald-400', ring: 'ring-emerald-500/20' }
  if (score >= 60) return { hex: '#0ea5b7', text: 'text-teal-600 dark:text-teal-400', ring: 'ring-teal-500/20' }
  if (score >= 40) return { hex: '#f59e0b', text: 'text-amber-600 dark:text-amber-400', ring: 'ring-amber-500/20' }
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

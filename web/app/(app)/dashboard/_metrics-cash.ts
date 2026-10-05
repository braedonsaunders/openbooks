import 'server-only'
import { getTranslations } from 'next-intl/server'
import { compareMoney } from '@/lib/cash/core'
import { MissingExchangeRateError } from '@/lib/fx-presentation'
import type { DashboardWidgetContext, WidgetValue } from './_metrics-context'

/**
 * Dashboard widget readers for cash conversion, cash pressure and the cash forecast (Cash Flow).
 *
 * Every figure is the Cash Flow position's own for the org's configured
 * horizon, scope and AP capacity settings: one cashPosition call per request
 * (memoized on the widget context) feeds the runway tile and every widget
 * below, so a tile and its dashboard can never disagree. Each field is read
 * only when a visible widget lists it in WIDGET_METRIC_FIELDS (_metrics.ts):
 * a denied or absent widget's reader never runs.
 */

export type CashLowestPoint = {
  amount: string
  /** Week-start ISO of the week the lowest projected cash occurs in. */
  week: string
  status: 'healthy' | 'caution' | 'critical'
  horizonWeeks: number
}

export type CashBurn = {
  weeklyOutflow: string
  netChange: string
  horizonWeeks: number
}

export type CashCoverage = {
  /** (cash + AR outstanding) / AP outstanding on the 0..n scale. */
  ratio: string
  /** At or above 1 the on-hand cash and receivables cover the payables. */
  covered: boolean
}

export type CashForecastWeek = {
  label: string
  inflow: string
  outflow: string
  net: string
  endingCash: string
}

export type CashForecast = {
  /** Weekly magnitudes only — the week's entries stay on the dashboard. */
  weeks: CashForecastWeek[]
  projectedEnd: string
  horizonWeeks: number
}

export type CashWidgetMetrics = {
  cashLowest: WidgetValue<CashLowestPoint> | null
  cashBurn: WidgetValue<CashBurn> | null
  cashCoverage: WidgetValue<CashCoverage> | null
  /** Mean days to collect (null = no collection history). */
  cashCollectDays: WidgetValue<number | null> | null
  /** Mean days to pay (null = no payment history). */
  cashPayDays: WidgetValue<number | null> | null
  cashForecast: WidgetValue<CashForecast> | null
}

export const EMPTY_CASH_WIDGET_METRICS: CashWidgetMetrics = {
  cashLowest: null,
  cashBurn: null,
  cashCoverage: null,
  cashCollectDays: null,
  cashPayDays: null,
  cashForecast: null,
}

export async function loadCashWidgetMetrics(
  ctx: DashboardWidgetContext,
  need: (...fields: (keyof CashWidgetMetrics)[]) => boolean,
): Promise<Partial<CashWidgetMetrics>> {
  if (!need('cashLowest', 'cashBurn', 'cashCoverage', 'cashCollectDays', 'cashPayDays', 'cashForecast')) return {}
  const read = ctx.cashPosition
  if (!read) return {}
  let position
  try {
    position = await read()
  } catch (error: unknown) {
    // A missing exchange rate refuses per widget with its message (the
    // runway tile answers the same condition with no-data); anything else
    // still throws.
    if (error instanceof MissingExchangeRateError) {
      const refused = { available: false as const, reason: error.message }
      const out: Partial<CashWidgetMetrics> = {}
      if (need('cashLowest')) out.cashLowest = refused
      if (need('cashBurn')) out.cashBurn = refused
      if (need('cashCoverage')) out.cashCoverage = refused
      if (need('cashCollectDays')) out.cashCollectDays = refused
      if (need('cashPayDays')) out.cashPayDays = refused
      if (need('cashForecast')) out.cashForecast = refused
      return out
    }
    throw error
  }
  const out: Partial<CashWidgetMetrics> = {}
  if (need('cashLowest')) {
    out.cashLowest = {
      available: true,
      value: {
        amount: position.lowestCash,
        week: position.lowestWeek,
        status: position.runwayStatus,
        horizonWeeks: position.horizonWeeks,
      },
    }
  }
  if (need('cashBurn')) {
    out.cashBurn = {
      available: true,
      value: {
        weeklyOutflow: position.burnRate,
        netChange: position.netChange,
        horizonWeeks: position.horizonWeeks,
      },
    }
  }
  if (need('cashCollectDays')) {
    out.cashCollectDays = { available: true, value: position.dso }
  }
  if (need('cashPayDays')) {
    out.cashPayDays = { available: true, value: position.dpo }
  }
  if (need('cashForecast')) {
    out.cashForecast = {
      available: true,
      value: {
        weeks: position.weeks.map((week) => ({
          label: week.label,
          inflow: week.inflow,
          outflow: week.outflow,
          net: week.net,
          endingCash: week.endingCash,
        })),
        projectedEnd: position.projectedEnd,
        horizonWeeks: position.horizonWeeks,
      },
    }
  }
  if (need('cashCoverage')) {
    // No AP outstanding means no coverage ratio exists — the tile names
    // that instead of dividing by zero or rendering 0× as a fact.
    out.cashCoverage =
      position.arCoverage === null
        ? { available: false, reason: (await getTranslations('dashboard'))('analytics.noPayables') }
        : {
            available: true,
            value: { ratio: position.arCoverage, covered: compareMoney(position.arCoverage, '1') >= 0 },
          }
  }
  return out
}

import type { NotForecastEntry } from '../../../../lib/cash/core'

/** Rows the not-forecast panel lists; the rest are counted, not shipped. */
export const NOT_FORECAST_ROWS = 8

export type NotForecastRow = Pick<NotForecastEntry, 'id' | 'partyName' | 'docNumber' | 'daysOverdue' | 'amount'>

/** The cockpit's view of receivables past the collectability horizon. */
export interface NotForecastSummary {
  horizonDays: number
  count: number
  total: string
  entries: NotForecastRow[]
}

import type { TrueCostData } from './true-cost-data'

/** Setup owns category, matrix and configuration editing. Employee selling
 * pools and analytical time series remain on the Analytics/report surfaces. */
export type TrueCostSetupData = Omit<TrueCostData, 'labor' | 'monthly' | 'forecast'> & {
  labor: Omit<TrueCostData['labor'], 'employees'>
}

export function trueCostSetupData(data: TrueCostData): TrueCostSetupData {
  const { monthly: _monthly, forecast: _forecast, labor, ...setup } = data
  const { employees: _employees, ...laborSummary } = labor
  return { ...setup, labor: laborSummary }
}

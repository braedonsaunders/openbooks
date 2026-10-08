'use client'

import type { TrueCostSetupData } from '../../../../../lib/analytics/true-cost-setup-data'
import { TrueCostView } from '../../../analytics/true-cost/TrueCostView'

/** Use the native rate editor with only the data its Setup bodies consume. */
export function TrueCostSetupView({ data }: { data: TrueCostSetupData }) {
  return <TrueCostView mode="setup" data={{
    ...data,
    labor: { ...data.labor, employees: [] },
    monthly: [],
    forecast: [],
  }} />
}

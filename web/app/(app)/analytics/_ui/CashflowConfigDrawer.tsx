'use client'

import { Drawer } from '@openbooks/ui'
import { ConfigEditor } from './ConfigEditor'
import { CategoryManager, type CatOption, type AccountOption } from './CategoryManager'
import type { ForecastCategory } from '../../../../lib/cash/core'

/**
 * The full cash-forecast configuration, in a flyout — the selection rule
 * (weekly AP cap + restrict-to-safe) and the recurring forecast categories
 * (payroll, rent, loan payments, GL-trend spend). Shared by the AP and Cash
 * cockpits; both write to the same org config the engine reads, so forecast,
 * planner and cockpits always agree.
 */
export function CashflowConfigDrawer({
  open,
  onClose,
  title,
  description,
  weeklyApCap,
  restrictToSafe,
  vendorOptions,
  accountOptions,
  initialCategories,
}: {
  open: boolean
  onClose: () => void
  title: string
  description: string
  weeklyApCap: number
  restrictToSafe: number
  vendorOptions: CatOption[]
  accountOptions: AccountOption[]
  initialCategories?: ForecastCategory[]
}) {
  if (!open) return null
  return (
    <Drawer open onClose={onClose} size="xl" title={title} description={description} bodyClassName="overflow-y-auto">
      <div className="space-y-5">
        <ConfigEditor
          dashboard="cashflow"
          fields={[
            { key: 'weeklyApCap', label: 'Weekly AP pay cap ($)', help: '0 = unlimited. With a cap, payables are chosen oldest-due-first up to this amount each week and the rest defers.', min: 0, max: 100_000_000, step: 1000 },
            { key: 'restrictToSafe', label: 'Restrict to safe capacity (0/1)', help: '1 = never recommend paying beyond the cash available that week (projected inflows − outflows). Overflow defers forward.', min: 0, max: 1, step: 1 },
          ]}
          values={{ weeklyApCap, restrictToSafe }}
          defaults={{ weeklyApCap: 0, restrictToSafe: 0 }}
        />
        <CategoryManager vendorOptions={vendorOptions} accountOptions={accountOptions} initialCategories={initialCategories} />
      </div>
    </Drawer>
  )
}

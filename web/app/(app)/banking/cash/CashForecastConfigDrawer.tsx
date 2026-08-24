'use client'

import { useMoney } from '@/components/money-provider'
import Link from 'next/link'
import { Drawer } from '@openbooks/ui'
import { SlidersHorizontal, Landmark, ArrowUpRight } from 'lucide-react'
import { Panel } from '../../analytics/_ui/Panel'
import { CategoryManager, type CatOption, type AccountOption } from '../../analytics/_ui/CategoryManager'
import type { ForecastCategory } from '../../../../lib/cash/core'
/**
 * Cash forecast configuration — the model behind the liquidity timeline. This
 * is the Cash cockpit's config: the recurring forecast categories (payroll,
 * rent, loans — the non-AR/AP flows) and the forecast model's parameters,
 * ported at full fidelity from the analytics Configuration tab. The AP
 * pay-selection rule is AP's config — shown read-only here with a link to its
 * home on the AP cockpit, never duplicated as a second editable copy.
 */
export function CashForecastConfigDrawer({
  onClose,
  title,
  description,
  asOf,
  horizonWeeks,
  dso,
  dpo,
  weeklyCap,
  restrictToSafe,
  vendorOptions,
  accountOptions,
  initialCategories,
}: {
  onClose: () => void
  title: string
  description: string
  asOf: string
  horizonWeeks: number
  dso: number
  dpo: number
  weeklyCap: number
  restrictToSafe: boolean
  vendorOptions: CatOption[]
  accountOptions: AccountOption[]
  initialCategories?: ForecastCategory[]
}) {
  const { money } = useMoney()
  const items: { label: string; value: string; note: string }[] = [
    { label: 'Forecast horizon', value: `${horizonWeeks} weeks`, note: 'Weeks of cash projected forward from today' },
    { label: 'As-of date', value: asOf, note: 'Anchor for open balances and predictions' },
    { label: 'Prediction method', value: 'Statistical → Due date → Global avg', note: 'Per-party average pay/collect days (+½σ buffer), floored at the due date' },
    { label: 'Overdue push', value: '+7 / +14 / +28 days', note: 'Overdue items pushed forward by how overdue they are (≤30 / ≤60 / >60 days)' },
    { label: 'Business-day snap', value: 'On', note: 'Predicted dates on a weekend move to the next business day' },
    { label: 'Global collect / pay days', value: `${dso}d / ${dpo}d`, note: 'Fallback averages used when a party has no payment history' },
  ]

  return (
    <Drawer open onClose={onClose} size="xl" title={title} description={description} bodyClassName="overflow-y-auto">
      <div className="space-y-5">
        <CategoryManager vendorOptions={vendorOptions} accountOptions={accountOptions} initialCategories={initialCategories} />

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <Panel title="Forecast Model" icon={SlidersHorizontal} bodyClassName="p-0">
            <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
              {items.map((i) => (
                <li key={i.label} className="flex items-start justify-between gap-4 px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-800 dark:text-slate-200">{i.label}</p>
                    <p className="text-xs text-slate-500 dark:text-slate-400">{i.note}</p>
                  </div>
                  <span className="shrink-0 rounded-md bg-slate-100 px-2 py-1 text-right text-sm font-semibold tabular-nums text-slate-700 dark:bg-slate-800 dark:text-slate-200">{i.value}</span>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel
            title="AP payment rule"
            icon={Landmark}
            hint="Configured on the AP cockpit"
            bodyClassName="p-0"
          >
            <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
              <li className="flex items-start justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-800 dark:text-slate-200">Weekly pay cap</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">Most payables paid per week; the rest defers</p>
                </div>
                <span className="shrink-0 rounded-md bg-slate-100 px-2 py-1 text-sm font-semibold tabular-nums text-slate-700 dark:bg-slate-800 dark:text-slate-200">{weeklyCap > 0 ? money(weeklyCap) : 'Unlimited'}</span>
              </li>
              <li className="flex items-start justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-800 dark:text-slate-200">Restrict to safe capacity</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">Never pay beyond the cash available that week</p>
                </div>
                <span className="shrink-0 rounded-md bg-slate-100 px-2 py-1 text-sm font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-200">{restrictToSafe ? 'On' : 'Off'}</span>
              </li>
              <li className="px-4 py-3">
                <Link href={('/ap')} className="inline-flex items-center gap-1 text-xs font-medium text-teal-600 hover:underline dark:text-teal-400">
                  Configure on the AP cockpit <ArrowUpRight size={12} />
                </Link>
              </li>
            </ul>
          </Panel>
        </div>
      </div>
    </Drawer>
  )
}

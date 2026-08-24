'use client'

import Link from 'next/link'
import { Drawer } from '@openbooks/ui'
import { ListOrdered, ArrowUpRight } from 'lucide-react'
import { ConfigEditor } from '../../analytics/_ui/ConfigEditor'
import { Panel } from '../../analytics/_ui/Panel'

/**
 * AP pay-selection configuration — the rule that decides WHICH bills the
 * pay-run planner recommends each week. This is AP's config: the weekly cap +
 * restrict-to-safe knobs (persisted to the shared cashflow config the engine
 * reads) plus the scheduling model behind the recommendation. The cash-wide
 * forecast model (recurring categories, prediction settings) lives on the
 * Cash cockpit — linked below, not duplicated here.
 */
export function ApSelectionConfigDrawer({
  onClose,
  title,
  description,
  weeklyCap,
  restrictToSafe,
  dpo,
}: {
  onClose: () => void
  title: string
  description: string
  weeklyCap: number
  restrictToSafe: boolean
  dpo: number
}) {
  const items: { label: string; value: string; note: string }[] = [
    { label: 'Selection order', value: 'Oldest due first', note: 'Bills are chosen oldest due date first, then largest amount, up to the week’s capacity — the rest defers forward' },
    { label: 'Payment-date prediction', value: 'Statistical → Due date → Global avg', note: 'Per-vendor average pay days (+½σ buffer), floored at the due date' },
    { label: 'Overdue push', value: '+7 / +14 / +28 days', note: 'Overdue bills pushed forward by how overdue they are (≤30 / ≤60 / >60 days)' },
    { label: 'Business-day snap', value: 'On', note: 'Predicted dates on a weekend move to the next business day' },
    { label: 'Avg days to pay (DPO)', value: `${dpo}d`, note: 'Fallback used when a vendor has no payment history' },
  ]

  return (
    <Drawer open onClose={onClose} size="lg" title={title} description={description} bodyClassName="overflow-y-auto">
      <div className="space-y-5">
        <ConfigEditor
          dashboard="cashflow"
          fields={[
            { key: 'weeklyApCap', label: 'Weekly AP pay cap ($)', help: '0 = unlimited. With a cap, payables are chosen oldest-due-first up to this amount each week and the rest defers.', min: 0, max: 100_000_000, step: 1000 },
            { key: 'restrictToSafe', label: 'Restrict to safe capacity (0/1)', help: '1 = never recommend paying beyond the cash available that week (projected inflows − outflows). Overflow defers forward.', min: 0, max: 1, step: 1 },
          ]}
          values={{ weeklyApCap: weeklyCap, restrictToSafe: restrictToSafe ? 1 : 0 }}
          defaults={{ weeklyApCap: 0, restrictToSafe: 0 }}
        />

        <Panel title="How bills are scheduled" icon={ListOrdered} bodyClassName="p-0">
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

        <p className="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400">
          Recurring flows (payroll, rent, loans) shape safe capacity — configure them on the
          <Link href={('/banking/cash')} className="inline-flex items-center gap-0.5 font-medium text-teal-600 hover:underline dark:text-teal-400">
            Cash cockpit <ArrowUpRight size={12} />
          </Link>
        </p>
      </div>
    </Drawer>
  )
}

'use client'

import Link from 'next/link'
import { Drawer } from '@openbooks/ui'
import { ListOrdered, ArrowUpRight } from 'lucide-react'
import { Panel } from '../../analytics/_ui/Panel'

/**
 * How collections are predicted — the AR side of the forecast model, read-only
 * because collections have no capacity scheduler (there is nothing to cap:
 * customers pay when they pay; the engine predicts when). The editable
 * forecast surfaces live in their homes: recurring flows on the Cash cockpit,
 * the AP pay rule on the AP cockpit.
 */
export function ArCollectionsInfoDrawer({
  onClose,
  title,
  description,
  dso,
}: {
  onClose: () => void
  title: string
  description: string
  dso: number
}) {
  const items: { label: string; value: string; note: string }[] = [
    { label: 'Worklist order', value: 'Most overdue first', note: 'The chase list sorts by days overdue, then largest amount — overdue invoices come pre-selected' },
    { label: 'Collection-date prediction', value: 'Statistical → Due date → Global avg', note: 'Per-customer average collect days (+½σ buffer), floored at the due date' },
    { label: 'Overdue push', value: '+7 / +14 / +28 days', note: 'Overdue invoices pushed forward by how overdue they are (≤30 / ≤60 / >60 days)' },
    { label: 'Business-day snap', value: 'On', note: 'Predicted dates on a weekend move to the next business day' },
    { label: 'Avg days to collect (DSO)', value: `${dso}d`, note: 'Fallback used when a customer has no payment history' },
  ]

  return (
    <Drawer open onClose={onClose} size="lg" title={title} description={description} bodyClassName="overflow-y-auto">
      <div className="space-y-5">
        <Panel title="How collections are predicted" icon={ListOrdered} bodyClassName="p-0">
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
          Recurring inflows (grants, rent received, subscriptions) join the forecast as categories — configure them on the
          <Link href={'/banking/cash' as any} className="inline-flex items-center gap-0.5 font-medium text-teal-600 hover:underline dark:text-teal-400">
            Cash cockpit <ArrowUpRight size={12} />
          </Link>
        </p>
      </div>
    </Drawer>
  )
}

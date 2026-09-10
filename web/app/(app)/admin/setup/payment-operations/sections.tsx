'use client'

import Link from 'next/link'
import { Plus } from 'lucide-react'
import { Button, cn } from '@openbooks/ui'
import { SetupEditor, type PaymentSetupView } from './PaymentOperationsSetup'
import type { PaymentOperationsData } from './view'

/**
 * Shared chrome for the payment-operations setup page.
 *
 * The native page is a client component, so these composites CANNOT live in a
 * `server-only` sections file the way the [entity] slots do — the four
 * exports below are client components imported by the coordinator's registry
 * entries (INTEGRATION.md), and the drawer chrome they wrap is itself client
 * state. What the spec cannot express lives here:
 *
 * - `PaymentOperationsTabs`: the four-view tab strip. The active-vs-plain
 *   link PAIR is a component, not a spec construct (presence cannot choose
 *   between two treatments) — the payroll `PayrollSetupTabs` precedent.
 * - `PaymentScheduleNextRun`: the schedules "Next run" cell. The native row
 *   formats `next_run_at` client-side, so the loader passes raw ISO and this
 *   cell runs the identical expression.
 * - `NewSetupRecordButton`: the per-view "New …" button. A `link-button`
 *   cannot render it: the native button carries a `Plus size={15}` icon and
 *   `link-button`'s closed icon map has no `plus` key.
 * - `PaymentOperationsEditor`: the create/edit drawer with its four
 *   per-view field sets. `SetupEditor` and friends own fetch flows plus
 *   client form state a spec cannot name (the /tax and payroll precedents),
 *   so the drawer stays whole and the spec places it by name over
 *   loader-resolved props.
 *
 * The native branch imports nothing back: `page.tsx` renders
 * `PaymentOperationsSetup` directly, while the spec path reaches the same
 * implementation through these shared wrappers. One implementation either
 * way — the wrappers below add no markup of their own.
 */

const VIEWS: PaymentSetupView[] = ['profiles', 'formats', 'schedules', 'mandates']

export function PaymentOperationsTabs({
  tabs,
}: {
  tabs: { key: string; href: string; label: string; active: boolean }[]
}) {
  // Byte contract: the native strip is a bare div of plain links with no
  // roles — the active-vs-plain link PAIR is the component (presence cannot
  // choose between two treatments). Rendered in VIEWS order like the native
  // map, with loader-resolved hrefs and labels.
  return (
    <div className="flex flex-wrap gap-1 border-b border-slate-200 dark:border-slate-800">
      {VIEWS.map((item) => {
        const tab = tabs.find((candidate) => candidate.key === item)
        if (!tab) return null
        return (
          <Link
            key={item}
            href={tab.href as never}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium',
              tab.active ? 'border-teal-600 text-teal-700 dark:text-teal-300' : 'border-transparent text-slate-500 hover:text-slate-900 dark:hover:text-slate-100',
            )}
          >
            {tab.label}
          </Link>
        )
      })}
    </div>
  )
}

/**
 * The schedules "Next run" cell. The native row formats `next_run_at`
 * client-side with `new Date(value).toLocaleString()`, falling back to an
 * em-dash — browser locale and timezone, not the server's. This cell runs
 * the identical expression so the spec render matches byte for byte.
 */
export function PaymentScheduleNextRun({ value }: { value: string | null }) {
  return <>{value ? new Date(value).toLocaleString() : '—'}</>
}

export function NewSetupRecordButton({ href, label }: { href: string; label: string }) {
  return (
    <Button asChild>
      <Link href={href as never}><Plus size={15} />{label}</Link>
    </Button>
  )
}

export function PaymentOperationsEditor({
  editor,
}: {
  editor: NonNullable<PaymentOperationsData['editor']>
}) {
  return (
    <SetupEditor
      view={editor.view}
      row={editor.row}
      creating={editor.creating}
      options={editor.options}
      closeHref={editor.closeHref}
      multiCurrency={editor.multiCurrency}
    />
  )
}

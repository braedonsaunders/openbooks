import { Badge } from '@openbooks/ui'

/**
 * The provision-run list table, moved out of `page.tsx` so the page and the widget registry
 * share one implementation.
 *
 * A widget rather than a `table` block, the same call the detail page made for
 * its two tables: the native markup is a hand-rolled `<table>` in a
 * `rounded-xl` card with its own cell padding, and the spec's table block
 * offers only the two real table shapes the app has. The empty state lives
 * inside the component because the native empty path keeps the card and table
 * chrome and renders the note as a `colSpan={6}` row — a spec-level empty
 * block would drop the header row the native page keeps.
 *
 * Every displayed value arrives finished. The em-dash for a missing effective
 * rate is loader-resolved text, not a conditional here, because deciding it
 * twice is how the two paths drift.
 */

export interface ProvisionRunListColumns {
  fiscalYear: string
  version: string
  status: string
  totalExpense: string
  effectiveRate: string
  created: string
}

export interface ProvisionRunListRow {
  id: string
  href: string
  fiscalYearLabel: string
  versionLabel: string
  statusLabel: string
  statusVariant: 'success' | 'secondary' | 'outline'
  totalExpense: string
  effectiveRateText: string
  created: string
}

export function ProvisionRunsTable({
  columns,
  emptyText,
  rows,
}: {
  columns: ProvisionRunListColumns
  emptyText: string
  rows: ProvisionRunListRow[]
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
            <th className="px-4 py-2 font-medium">{columns.fiscalYear}</th>
            <th className="px-4 py-2 font-medium">{columns.version}</th>
            <th className="px-4 py-2 font-medium">{columns.status}</th>
            <th className="px-4 py-2 text-right font-medium">{columns.totalExpense}</th>
            <th className="px-4 py-2 text-right font-medium">{columns.effectiveRate}</th>
            <th className="px-4 py-2 font-medium">{columns.created}</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={6} className="px-4 py-10 text-center text-slate-400 italic">
                {emptyText}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr
                key={row.id}
                className="border-b border-slate-100 last:border-0 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/40"
              >
                <td className="px-4 py-2.5">
                  <a
                    className="font-medium text-teal-700 hover:underline dark:text-teal-300"
                    href={row.href}
                  >
                    {row.fiscalYearLabel}
                  </a>
                </td>
                <td className="px-4 py-2.5 tabular-nums">{row.versionLabel}</td>
                <td className="px-4 py-2.5">
                  <Badge variant={row.statusVariant}>{row.statusLabel}</Badge>
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">{row.totalExpense}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{row.effectiveRateText}</td>
                <td className="px-4 py-2.5 text-slate-500 dark:text-slate-400">{row.created}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}

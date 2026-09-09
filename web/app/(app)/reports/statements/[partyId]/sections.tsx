import { ReportDrillLink } from '../../ReportDrillLink'
import type { ReportDrillTarget } from '../../../../../lib/report-drill'

/**
 * The aging summary strip above a party statement: one drilled figure per
 * bucket plus a total, laid out as equal auto-columns with dividers.
 *
 * A component rather than a block — it is a bespoke strip, not a table, and a
 * block for it would serve exactly one page. Both render paths import it.
 */
export function AgingStrip({
  cells,
  totalLabel,
  total,
  totalDrill,
}: {
  cells: { key: string; label: string; value: string; drill: ReportDrillTarget }[]
  totalLabel: string
  total: string
  totalDrill: ReportDrillTarget
}) {
  const linkClass = 'hover:text-teal-700 hover:underline dark:hover:text-teal-300'
  return (
    <div className="mb-6 grid grid-flow-col auto-cols-fr divide-x divide-slate-200 border-y border-slate-200 py-3 dark:divide-slate-700 dark:border-slate-700">
      {cells.map((cell) => (
        <div key={cell.key} className="min-w-0 px-2 text-center">
          <div className="truncate text-xs text-slate-500 dark:text-slate-400">{cell.label}</div>
          <div className="truncate tabular-nums">
            <ReportDrillLink target={cell.drill} className={linkClass}>
              {cell.value}
            </ReportDrillLink>
          </div>
        </div>
      ))}
      <div className="min-w-0 px-2 text-center font-semibold">
        <div className="truncate text-xs text-slate-500 dark:text-slate-400">{totalLabel}</div>
        <div className="truncate tabular-nums">
          <ReportDrillLink target={totalDrill} className={linkClass}>
            {total}
          </ReportDrillLink>
        </div>
      </div>
    </div>
  )
}

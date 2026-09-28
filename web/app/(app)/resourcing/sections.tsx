import { TieOutTable, type TieOutLabels } from './TieOutTable'
import type { PlanVsActualRow } from '../../../lib/resourcing/tie-out'

/**
 * The resourcing cockpit's tie-out section, extracted from the page.
 *
 * Like the purchasing cockpit's hero, the empty case lives here rather than
 * as a conditional pair of blocks in the spec: a component that knows how to
 * render itself with no rows is the ordinary answer, and the native page and
 * the spec render the same component so they cannot drift.
 */
export function TieOutSection({
  rows,
  labels,
  empty,
}: {
  rows: PlanVsActualRow[]
  labels: TieOutLabels
  empty: string
}) {
  if (rows.length === 0) {
    return (
      <div className="px-6 py-16 text-center">
        <p className="text-sm text-slate-400 dark:text-slate-500">{empty}</p>
      </div>
    )
  }
  return <TieOutTable rows={rows} labels={labels} />
}

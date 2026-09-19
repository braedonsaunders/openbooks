/**
 * The HRM cockpit's bespoke sections, extracted from the page.
 *
 * ViewSpec composes the grid and the panels; the panel BODIES stay
 * components, shared by the page and the widget registry via this file so
 * they cannot drift — the same division the purchasing and banking
 * cockpits established (see ../../purchasing/sections.tsx and
 * ../banking/sections.tsx).
 */

export type HrmHeadcountRow = {
  subsidiary: string
  department: string | null
  headcount: number
}

/**
 * Headcount as-of today by employer subsidiary and department, INCLUDING
 * its empty state. The empty case lives here rather than as a conditional
 * pair of blocks in the spec: a resolved zero is data (nobody in service
 * on the date), and the component that knows how to render itself when it
 * has no rows is the ordinary answer.
 */
export function HrmHeadcountTable({
  groups,
  total,
  employerColumn,
  departmentColumn,
  headcountColumn,
  unassigned,
  empty,
  totalLabel,
}: {
  groups: HrmHeadcountRow[]
  total: number
  employerColumn: string
  departmentColumn: string
  headcountColumn: string
  unassigned: string
  empty: string
  totalLabel: string
}) {
  if (groups.length === 0) {
    return <p className="px-4 py-6 text-center text-sm text-slate-400 dark:text-slate-500">{empty}</p>
  }
  return (
    <table className="w-full text-sm">
      <thead className="sticky top-0 z-10 bg-white dark:bg-slate-900">
        <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
          <th className="px-4 py-2 text-left font-medium">{employerColumn}</th>
          <th className="px-3 py-2 text-left font-medium">{departmentColumn}</th>
          <th className="px-4 py-2 text-right font-medium">{headcountColumn}</th>
        </tr>
      </thead>
      <tbody>
        {groups.map((group, i) => (
          <tr key={`${group.subsidiary}-${group.department ?? ''}-${i}`} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
            <td className="px-4 py-2 font-medium text-slate-700 dark:text-slate-200">{group.subsidiary}</td>
            <td className="px-3 py-2 text-slate-500 dark:text-slate-400">{group.department ?? unassigned}</td>
            <td className="px-4 py-2 text-right font-semibold tabular-nums text-slate-800 dark:text-slate-100">
              {group.headcount.toLocaleString()}
            </td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="border-t border-slate-100 dark:border-slate-800">
          <td className="px-4 py-2 font-semibold text-slate-900 dark:text-slate-100" colSpan={2}>
            {totalLabel}
          </td>
          <td className="px-4 py-2 text-right font-semibold tabular-nums text-slate-900 dark:text-slate-100">
            {total.toLocaleString()}
          </td>
        </tr>
      </tfoot>
    </table>
  )
}

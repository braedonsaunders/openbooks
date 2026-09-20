import Link from 'next/link'
import { UrlDrawer } from '@openbooks/ui'
import { PositionCreateForm } from './PositionCreateForm'
import type { PositionRow, PositionSegment, PositionsPageData } from './view'

/**
 * Positions list sections (server components): the status segment nav, the
 * vacancy table the loader resolved through the canonical position read
 * service, the URL drawer shell around the drawer body with versions,
 * funding by period, and the current holder, and the by-department vacancy
 * table the HR overview embeds as the hrm-vacancy-table widget. Every
 * string arrives loader-resolved as props — no org id, user id, or Authz
 * crosses into render.
 */

/** Status segments: server-side filter pills with per-status counts. */
export function PositionSegments({
  ariaLabel,
  segments,
}: {
  ariaLabel: string
  segments: PositionSegment[]
}) {
  return (
    <nav aria-label={ariaLabel} className="flex flex-wrap gap-2">
      {segments.map((segment) => (
        <Link
          key={segment.key}
          href={segment.href}
          aria-current={segment.active ? 'page' : undefined}
          className={
            segment.active
              ? 'rounded-full bg-slate-900 px-3 py-1 text-xs font-medium text-white dark:bg-slate-100 dark:text-slate-900'
              : 'rounded-full border border-slate-200 px-3 py-1 text-xs text-slate-600 hover:border-slate-400 dark:border-slate-700 dark:text-slate-300'
          }
        >
          {segment.label} · {segment.count}
        </Link>
      ))}
    </nav>
  )
}

export function PositionsTable({
  columns,
  rows,
  empty,
  totals,
  totalLabel,
}: {
  columns: Record<string, string>
  rows: PositionRow[]
  empty: string
  totals: { plannedFte: string; fundedFte: string; filledFte: string; vacantFte: string }
  totalLabel: string
}) {
  if (rows.length === 0) {
    return <p className="px-4 py-6 text-center text-sm text-slate-400 dark:text-slate-500">{empty}</p>
  }
  return (
    <table className="w-full text-sm">
      <thead className="sticky top-0 z-10 bg-white dark:bg-slate-900">
        <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
          <th className="px-4 py-2 text-left font-medium">{columns.code}</th>
          <th className="px-3 py-2 text-left font-medium">{columns.title}</th>
          <th className="px-3 py-2 text-left font-medium">{columns.status}</th>
          <th className="px-3 py-2 text-left font-medium">{columns.department}</th>
          <th className="px-3 py-2 text-right font-medium">{columns.planned}</th>
          <th className="px-3 py-2 text-right font-medium">{columns.funded}</th>
          <th className="px-3 py-2 text-right font-medium">{columns.filled}</th>
          <th className="px-3 py-2 text-right font-medium">{columns.vacant}</th>
          <th className="px-4 py-2 text-left font-medium">{columns.holder}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
            <td className="px-4 py-2 font-medium text-slate-700 dark:text-slate-200">
              <Link href={row.href} className="underline decoration-slate-300 underline-offset-2 hover:decoration-slate-500">
                {row.code}
              </Link>
            </td>
            <td className="px-3 py-2 text-slate-500 dark:text-slate-400">{row.title}</td>
            <td className="px-3 py-2 text-slate-500 dark:text-slate-400">{row.statusLabel}</td>
            <td className="px-3 py-2 text-slate-500 dark:text-slate-400">{row.department ?? '—'}</td>
            <td className="px-3 py-2 text-right tabular-nums text-slate-800 dark:text-slate-100">{row.plannedFte}</td>
            <td className="px-3 py-2 text-right tabular-nums text-slate-800 dark:text-slate-100">{row.fundedFte}</td>
            <td className="px-3 py-2 text-right tabular-nums text-slate-800 dark:text-slate-100">{row.filledFte}</td>
            <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-800 dark:text-slate-100">
              {row.vacantFte}
            </td>
            <td className="px-4 py-2 text-slate-500 dark:text-slate-400">{row.holderLabel}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="border-t border-slate-100 dark:border-slate-800">
          <td className="px-4 py-2 font-semibold text-slate-900 dark:text-slate-100" colSpan={4}>
            {totalLabel}
          </td>
          <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-900 dark:text-slate-100">
            {totals.plannedFte}
          </td>
          <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-900 dark:text-slate-100">
            {totals.fundedFte}
          </td>
          <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-900 dark:text-slate-100">
            {totals.filledFte}
          </td>
          <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-900 dark:text-slate-100">
            {totals.vacantFte}
          </td>
          <td className="px-4 py-2" />
        </tr>
      </tfoot>
    </table>
  )
}

export interface VacancyGroup {
  department: string
  employer: string
  positions: number
  plannedFte: string
  fundedFte: string
  filledFte: string
  vacantFte: string
}

/** Vacancy by department: the departments-board breakdown of the headcount plan. */
export function VacancyTable({
  groups,
  total,
  departmentColumn,
  employerColumn,
  positionsColumn,
  plannedColumn,
  fundedColumn,
  filledColumn,
  vacantColumn,
  empty,
  totalLabel,
}: {
  groups: VacancyGroup[]
  total: { positions: number; plannedFte: string; fundedFte: string; filledFte: string; vacantFte: string }
  departmentColumn: string
  employerColumn: string
  positionsColumn: string
  plannedColumn: string
  fundedColumn: string
  filledColumn: string
  vacantColumn: string
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
          <th className="px-3 py-2 text-right font-medium">{positionsColumn}</th>
          <th className="px-3 py-2 text-right font-medium">{plannedColumn}</th>
          <th className="px-3 py-2 text-right font-medium">{fundedColumn}</th>
          <th className="px-3 py-2 text-right font-medium">{filledColumn}</th>
          <th className="px-4 py-2 text-right font-medium">{vacantColumn}</th>
        </tr>
      </thead>
      <tbody>
        {groups.map((group, i) => (
          <tr key={`${group.employer}-${group.department}-${i}`} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
            <td className="px-4 py-2 font-medium text-slate-700 dark:text-slate-200">{group.employer}</td>
            <td className="px-3 py-2 text-slate-500 dark:text-slate-400">{group.department}</td>
            <td className="px-3 py-2 text-right tabular-nums text-slate-800 dark:text-slate-100">{group.positions}</td>
            <td className="px-3 py-2 text-right tabular-nums text-slate-800 dark:text-slate-100">{group.plannedFte}</td>
            <td className="px-3 py-2 text-right tabular-nums text-slate-800 dark:text-slate-100">{group.fundedFte}</td>
            <td className="px-3 py-2 text-right tabular-nums text-slate-800 dark:text-slate-100">{group.filledFte}</td>
            <td className="px-4 py-2 text-right font-semibold tabular-nums text-slate-800 dark:text-slate-100">
              {group.vacantFte}
            </td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="border-t border-slate-100 dark:border-slate-800">
          <td className="px-4 py-2 font-semibold text-slate-900 dark:text-slate-100" colSpan={2}>
            {totalLabel}
          </td>
          <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-900 dark:text-slate-100">
            {total.positions}
          </td>
          <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-900 dark:text-slate-100">
            {total.plannedFte}
          </td>
          <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-900 dark:text-slate-100">
            {total.fundedFte}
          </td>
          <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-900 dark:text-slate-100">
            {total.filledFte}
          </td>
          <td className="px-4 py-2 text-right font-semibold tabular-nums text-slate-900 dark:text-slate-100">
            {total.vacantFte}
          </td>
        </tr>
      </tfoot>
    </table>
  )
}

export interface PositionDetail {
  code: string
  title: string
  version: string
  effective: string
  recorded: string
  plannedFte: string
  statusLabel: string
  fundingTitle: string
  funding: { period: string; funded: string; costPlan: string | null }[]
  unfunded: string
  holderTitle: string
  holder: string | null
  noHolder: string
  warningsTitle: string
  warnings: string[]
  refusal: string | null
}

/** The position flyout body: version, funding by period, and current holder. */
export function PositionDrawerBody({ detail }: { detail: PositionDetail }) {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          {detail.title} · {detail.plannedFte} FTE · {detail.statusLabel}
        </h3>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{detail.version}</p>
        <p className="text-xs text-slate-500 dark:text-slate-400">{detail.effective}</p>
        <p className="text-xs text-slate-500 dark:text-slate-400">{detail.recorded}</p>
      </div>
      {detail.refusal ? (
        <p role="alert" className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">
          {detail.refusal}
        </p>
      ) : null}
      <div>
        <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{detail.fundingTitle}</h4>
        {detail.funding.length === 0 ? (
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{detail.unfunded}</p>
        ) : (
          <ul className="mt-1 space-y-1.5">
            {detail.funding.map((plan) => (
              <li key={plan.period} className="text-sm text-slate-600 dark:text-slate-300">
                <span className="font-medium">{plan.period}</span>: {plan.funded}
                {plan.costPlan ? ` · ${plan.costPlan}` : null}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{detail.holderTitle}</h4>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          {detail.holder ?? detail.noHolder}
        </p>
      </div>
      {detail.warnings.length > 0 ? (
        <div>
          <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{detail.warningsTitle}</h4>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-600 dark:text-slate-300">
            {detail.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

/**
 * The position flyout shell: a URL drawer around PositionDrawerBody that
 * closes by navigation, or the named absence for a bookmarked id that no
 * longer resolves. Null payload renders nothing — the spec's `when` gate
 * already omits it, so this is the second half of the same guard.
 */
export function PositionDrawer({
  drawer,
}: {
  drawer: {
    closeHref: string
    title: string
    description: string | null
    detail: PositionsPageData['detail']
    missingDetail: string | null
    /** The create form's inputs when the URL asks for a new position. */
    create?: PositionsPageData['create']
  } | null
}) {
  if (!drawer) return null
  return (
    <UrlDrawer
      open
      closeHref={drawer.closeHref}
      title={drawer.title}
      description={drawer.description ?? undefined}
    >
      {drawer.create ? (
        <PositionCreateForm {...drawer.create} />
      ) : drawer.detail ? (
        <PositionDrawerBody detail={drawer.detail} />
      ) : drawer.missingDetail ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">{drawer.missingDetail}</p>
      ) : null}
    </UrlDrawer>
  )
}

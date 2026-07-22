'use client'

import { useEffect, useMemo, useState } from 'react'
import { useFormatter } from 'next-intl'
import { useMoney } from '@/components/money-provider'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@openbooks/ui'
import type { StatementView } from '../../../lib/statement-matrix'
import type { StatementBasis, StatementDimFilter } from '../../../lib/statement-matrix'
import { buildDrillTarget, type ReportScale } from '../../../lib/report-filters'
import { isNegative, scaleDivisor } from '../../../lib/statement-format'
import { ReportDrillLink } from './ReportDrillLink'
import { REPORT_SECTION_VISIBILITY_EVENT, type ReportSectionVisibility } from './report-section-events'

/**
 * Renders a multi-column statement view (P&L, Balance Sheet, …) as a clean,
 * paper-style statement — no card chrome, no zebra: just a ruled header, section
 * headings, indented account rows, and bold subtotal/total rows with a rule
 * above (double rule below the grand total). The currency symbol shows on every
 * amount row. Every amount drills through. Section headings and parent accounts
 * carry a subtle chevron to collapse/expand their rows.
 */

/** Last descendant index of row `i` (section → its account rows; parent account
 *  → its deeper account rows). Returns `i` when the row has no children. */
function descendantEnd(lines: StatementView['lines'], i: number): number {
  const row = lines[i]
  let j = i + 1
  if (row.kind === 'section') {
    while (j < lines.length && lines[j].kind === 'account') j++
    return j - 1
  }
  if (row.kind === 'account') {
    while (j < lines.length && lines[j].kind === 'account' && lines[j].depth > row.depth) j++
    return j - 1
  }
  return i
}

export function StatementMatrixTable({
  view,
  scale = 'actual',
  currency,
  drill,
}: {
  view: StatementView
  scale?: ReportScale
  /** Currency code (e.g. 'CAD') → symbol shown on amount rows. */
  currency?: string
  drill?: { dims: StatementDimFilter; basis: StatementBasis; subsidiaryId?: string; budgetScenarioId?: string }
}) {
  const t = useTranslations('reports.filterBar')
  const format = useFormatter()
  const { money } = useMoney()
  const cols = view.columns
  const lines = view.lines
  const valueText = (value: number, kind: StatementView['columns'][number]['kind']): string => {
    if (kind === 'variance_pct') return format.number(value / 100, { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 })
    const scaled = value / scaleDivisor(scale)
    const digits = scale === 'actual' ? undefined : 0
    if (Math.abs(scaled) < (digits === 0 ? 0.5 : 0.005)) return '–'
    return money(scaled, {
      currency,
      accounting: true,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })
  }

  // Merged group headings (e.g. one per department) when breakout is combined
  // with a compare — consecutive columns sharing a `group` span one heading.
  const hasGroups = cols.some((c) => c.group)
  const spans: { group: string; span: number }[] = []
  if (hasGroups) {
    for (const c of cols) {
      const last = spans[spans.length - 1]
      if (last && last.group === (c.group ?? '')) last.span++
      else spans.push({ group: c.group ?? '', span: 1 })
    }
  }
  // First column index of each group, for a subtle divider between groups.
  const groupStart = new Set<number>()
  if (hasGroups) {
    let i = 0
    for (const s of spans) {
      if (i > 0) groupStart.add(i)
      i += s.span
    }
  }

  // Which rows can collapse, and the descendant range each one hides.
  const ranges = useMemo(() => {
    const map = new Map<number, number>()
    lines.forEach((_, i) => {
      const end = descendantEnd(lines, i)
      if (end > i) map.set(i, end)
    })
    return map
  }, [lines])

  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())

  useEffect(() => {
    const handleVisibility = (event: Event) => {
      const visibility = (event as CustomEvent<ReportSectionVisibility>).detail
      setCollapsed(visibility === 'collapse' ? new Set(ranges.keys()) : new Set())
    }
    window.addEventListener(REPORT_SECTION_VISIBILITY_EVENT, handleVisibility)
    return () => window.removeEventListener(REPORT_SECTION_VISIBILITY_EVENT, handleVisibility)
  }, [ranges])

  const hidden = useMemo(() => {
    const h = new Set<number>()
    for (const i of collapsed) {
      const end = ranges.get(i)
      if (end === undefined) continue
      for (let k = i + 1; k <= end; k++) h.add(k)
    }
    return h
  }, [collapsed, ranges])

  const toggle = (i: number) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      next.has(i) ? next.delete(i) : next.add(i)
      return next
    })

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm tabular-nums">
        <thead>
          {hasGroups && (
            <tr>
              <th className="min-w-[16rem]" />
              {spans.map((s, i) => (
                <th
                  key={i}
                  colSpan={s.span}
                  className="border-b border-slate-200 px-4 pt-1 pb-1 text-center text-xs font-semibold tracking-wide text-slate-500 uppercase dark:border-slate-700 dark:text-slate-400"
                >
                  {s.group}
                </th>
              ))}
            </tr>
          )}
          <tr className="border-b border-slate-300 dark:border-slate-600">
            <th className="min-w-[16rem] py-2 pr-4 text-left font-semibold text-slate-500 dark:text-slate-400" />
            {cols.map((c, ci) => (
              <th
                key={c.key}
                className={cn(
                  'py-2 pl-4 text-right font-semibold whitespace-nowrap',
                  c.kind === 'amount' ? 'text-slate-600 dark:text-slate-300' : 'text-slate-400 dark:text-slate-500',
                  groupStart.has(ci) && 'border-l border-slate-200 dark:border-slate-700',
                )}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => {
            if (hidden.has(i)) return null
            const canToggle = ranges.has(i)
            const isCollapsed = collapsed.has(i)
            const chevron = canToggle ? (
              <button
                type="button"
                onClick={() => toggle(i)}
                aria-label={isCollapsed ? t('expandSection', { section: l.label }) : t('collapseSection', { section: l.label })}
                className="mr-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
              >
                {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
              </button>
            ) : (
              <span className="mr-0.5 inline-block h-4 w-4 shrink-0" />
            )

            if (l.kind === 'section') {
              return (
                <tr key={i}>
                  <td
                    colSpan={cols.length + 1}
                    className="pt-4 pb-1 text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400"
                  >
                    <span className="inline-flex items-center">
                      {chevron}
                      {l.label}
                    </span>
                  </td>
                </tr>
              )
            }
            const isSub = l.kind === 'subtotal'
            const isTotal = l.kind === 'total'
            const isTotalish = isSub || isTotal
            const weight = isTotal || l.emphasis ? 'font-semibold text-slate-900 dark:text-slate-100' : isSub ? 'font-medium' : ''

            return (
              <tr
                key={i}
                className={cn(
                  isTotalish && '[&>td]:border-t [&>td]:border-slate-300 dark:[&>td]:border-slate-600',
                  isTotal && '[&>td]:border-b-[3px] [&>td]:border-double [&>td]:border-slate-400 dark:[&>td]:border-slate-500',
                )}
              >
                <td
                  className={cn(
                    'py-1 pr-4',
                    weight,
                    l.depth === 1 && 'pl-6',
                    l.depth === 2 && 'pl-10',
                    l.depth >= 3 && 'pl-14',
                  )}
                >
                  <span className="inline-flex items-baseline">
                    {l.kind === 'account' ? chevron : null}
                    {l.kind === 'account' && l.accountId ? (
                      <Link href={`/accounts/${l.accountId}`} className="hover:text-teal-700 dark:hover:text-teal-300">
                        {l.number && <span className="mr-1.5 font-mono text-xs text-slate-400 dark:text-slate-500">{l.number}</span>}
                        {l.label}
                      </Link>
                    ) : (
                      l.label
                    )}
                  </span>
                </td>
                {cols.map((c, ci) => {
                  const v = l.values?.[ci]
                  const target =
                    drill && v !== undefined
                      ? buildDrillTarget({
                          accountId: l.accountId,
                          drillTypes: l.drillTypes,
                          column: c,
                          sourceColumns: cols,
                          mode: view.mode,
                          reportDims: drill.dims,
                          basis: drill.basis,
                          subsidiaryId: drill.subsidiaryId,
                          label: `${l.label} · ${c.label}`,
                          budgetScenarioId: drill.budgetScenarioId,
                        })
                      : null
                  const neg = v !== undefined && isNegative(v, c.kind)
                  const text = v === undefined ? '' : valueText(v, c.kind)
                  return (
                    <td
                      key={c.key}
                      className={cn(
                        'py-1 pl-4 text-right whitespace-nowrap',
                        weight,
                        neg && 'text-red-600 dark:text-red-400',
                        groupStart.has(ci) && 'border-l border-slate-100 dark:border-slate-800',
                      )}
                    >
                      {target ? (
                        <ReportDrillLink target={target} className="hover:text-teal-700 hover:underline dark:hover:text-teal-300">
                          {text}
                        </ReportDrillLink>
                      ) : (
                        text
                      )}
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

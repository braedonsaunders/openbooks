import 'server-only'

import { registeredListTable } from '../../../../../../lib/list/prepared-spec'
import { notFound } from 'next/navigation'
import {
  badge,
  column,
  field as item,
  heading,
  link,
  page,
  pageHeader,
  panel,
  text,
  widget,
  widgetBlock,
  widgetCell,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { compensationAuthz, loadCompCycleDetail } from '../../../../../../lib/hrm/compensation'

/**
 * The team grid: one ViewSpec table with the employment, current rate,
 * band placement bar, rating, guideline range, proposed % and rate,
 * status, and reason chip; the budget pacing bar on top; filter chips
 * by department; the Flows approval widget drives bulk approval while
 * the per-line drawer carries propose/decide plus the event history.
 * Rows open the line drawer through the `line` search param.
 */

const f = item

export function compCycleSpec(data: NonNullable<Awaited<ReturnType<typeof loadCompCycleDetail>>>): PageSpec {
  return page({
    route: '/hrm/compensation/cycles/[id]',
    layout: 'list',
    bodyClassName: 'flex h-full min-h-0 flex-col gap-4',
    header: [
      pageHeader({
        title: f('title'),
        description: f('effectiveOn'),
        actionsClassName: 'flex flex-wrap items-center gap-3',
        actions: [
          widget('link-button', { href: f('backHref'), label: f('backLabel'), iconKey: 'arrow-left', variant: 'outline' }),
          widget('module-home-tabs', { tabs: data.tabs }),
        ],
      }),
    ],
    body: [
      widgetBlock('hrm-pacing-bar', { pct: f('pacingPct'), note: f('pacingNote') }),
      // The lifecycle block (open/submit/push/close/cancel) sits above the
      // team grid while the loader arms it — null for readers, so the move
      // buttons never appear where the POST endpoint would refuse them.
      {
        ...panel({
          title: f('move.title'),
          blocks: [widgetBlock('hrm-comp-cycle-move', { cycleId: f('cycleId'), move: f('move') })],
        }),
        when: f('move'),
      },
      // The team grid renders as a direct list under a house heading —
      // the department filter rides the list's toolbar slot, never a lone
      // chips row duplicating the heading below it.
      heading(2, f('linesTitle'), 'text-sm font-semibold text-slate-900 dark:text-slate-100'),
      registeredListTable(
        'hrm_compensation_cycle_lines',
        {
          variant: 'app',
          rows: f('lines'),
          rowKey: item('id'),
          empty: { title: f('linesEmpty') },
          columns: [
            column(f('columns.employee'), link(item('employeeName'), item('lineHref'))),
            column(f('columns.current'), text(item('current')), { align: 'right', className: 'tabular-nums' }),
            column(
              f('columns.placement'),
              widgetCell('hrm-placement-bar', {
                min: item('placementMin'),
                target: item('placementTarget'),
                max: item('placementMax'),
                rate: item('placementRate'),
                label: item('placementLabel'),
              }),
            ),
            column(f('columns.rating'), text(item('rating'))),
            column(f('columns.guideline'), text(item('guideline'))),
            column(f('columns.proposed'), text(item('proposedPct')), { align: 'right', className: 'tabular-nums' }),
            column(f('columns.status'), badge(item('statusLabel'), { variant: item('statusVariant') })),
          ],
        },
        [
          widget('list-toolbar', {
            basePath: data.cycleHref,
            currentParams: data.currentParams,
            filters: [
              {
                paramKey: 'department',
                label: f('linesTitle'),
                allLabel: f('backLabel'),
                options: data.departments,
              },
            ],
          }),
        ],
      ),
      {
        ...widgetBlock('hrm-comp-line-drawer', {
          drawer: {
            open: data.openLineId !== null,
            closeHref: data.drawerCloseHref,
            title: data.openLine?.employeeName ?? data.title,
            line: data.openLine,
            history: data.openLineHistory,
            labels: data.drawerLabels,
            cycleId: data.cycleId,
            canDecide: data.canDecide,
            canPropose: data.lineActions.canPropose,
            canDecideLine: data.lineActions.canDecideLine,
            historyColumns: data.historyColumns,
            emptyHistory: data.emptyHistory,
          },
        }),
        when: f('openLineId'),
      },
    ],
  })
}

export async function compCycleTitle(cycleId: string): Promise<string> {
  const authz = await compensationAuthz()
  if (!authz) notFound()
  const data = await loadCompCycleDetail(authz, cycleId, {})
  if (!data) notFound()
  return data.title
}

export async function loadCompCyclePage(cycleId: string, sp: Record<string, string | undefined>) {
  const authz = await compensationAuthz()
  if (!authz) notFound()
  const data = await loadCompCycleDetail(authz, cycleId, sp)
  if (!data) notFound()
  return data
}

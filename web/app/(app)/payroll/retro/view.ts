import 'server-only'

import { getTranslations } from 'next-intl/server'
import { page, pageHeader, ref, widget, widgetBlock, type PageSpec } from '@openbooks/viewspec'
import { can, requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { scopedRetroSchedules } from '../../../../lib/payroll-scoped-views'
import { groupTabs } from '../../../../components/module-home/group-tabs'
import type { RetroSchedule } from './RetroWorkspace'

/**
 * Retroactive pay — the workspace, split into a loader and a spec.
 *
 * This page is a fully client-interactive workspace: a schedule select and a
 * pay-date input held in component state, a propose POST with toast feedback,
 * a create POST that routes into the pay-run wizard, an exclusion checkbox
 * set, two `PagedTable`s with client-side search and paging, and a detail
 * drawer that opens from a clicked row object (there is no `?period=`
 * flyout param — the drawer is not URL-addressable). None of that is spec
 * vocabulary. Decomposing the tables into `table` blocks would split one
 * component's state across two render paths and reimplement its conditional
 * pairs (payable-vs-em-dash money cells, the toned difference cell, the
 * four-way outcome badge, the payable-only checkbox cell) as spec constructs
 * that do not exist.
 *
 * So the spec places the workspace whole through one widget, the same call
 * the parallel-run page made: `RetroWorkspace` moves nowhere and is shared
 * by the page and the widget registry. The loader below copies page.tsx verbatim — the
 * `payroll.read` gate, the `payroll` feature gate (404 when disabled), the
 * scoped schedule read, the module tabs, and the `payroll.run` flag — and
 * hands the schedule rows to the widget untouched.
 *
 * Money, dates and counts are NOT formatted here. The native component
 * formats them client-side (`useMoney` is browser-locale via `next-intl` +
 * `MoneyProvider`), so the loader passes the canonical store values through
 * and the component does what it always did.
 */

export interface PayrollRetroData {
  title: string
  description: string
  viewTabs: { href: string; label: string; active?: boolean }[]
  workspace: {
    schedules: RetroSchedule[]
    canRun: boolean
  }
}

export async function loadPayrollRetro(
  _sp: Record<string, string | string[] | undefined>,
): Promise<PayrollRetroData> {
  const authz = await requirePermission('payroll.read')
  const orgId = authz.user.orgId
  await requireFeatureEnabled(orgId, 'payroll')

  const t = await getTranslations('payroll')
  const text = (key: string, fallback: string) =>
    t.has(key as never) ? t(key as never) : fallback

  const schedules: RetroSchedule[] = await scopedRetroSchedules(authz)

  const tabs = await groupTabs('payroll', '/payroll/retro', { orgId })

  return {
    title: text('retro.title', 'Retroactive pay'),
    description: text(
      'retro.description',
      'A raise backdated over periods that have already been paid. Recalculate each of those periods, see what it should have paid against what it did, and pay the difference — taxed as the jurisdiction requires and costed to the jobs the hours were charged to.',
    ),
    viewTabs: tabs,
    workspace: {
      schedules,
      canRun: can(authz, 'payroll.run'),
    },
  }
}

const f = ref<PayrollRetroData>()

export function payrollRetroSpec(_data: PayrollRetroData): PageSpec {
  return page({
    route: '/payroll/retro',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actions: [widget('module-home-tabs', { tabs: _data.viewTabs })],
      }),
    ],
    body: [
      // The whole workspace — schedule/pay-date controls, the idle copy,
      // the summary tiles, the exceptions panel, both PagedTables, the
      // create-run action and the detail drawer — placed through one
      // widget. The component owns picker state, fetch mutations and every
      // conditional pair; the spec only names where it lives.
      widgetBlock('retro-workspace', {
        schedules: f('workspace.schedules'),
        canRun: f('workspace.canRun'),
      }),
    ],
  })
}

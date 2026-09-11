import 'server-only'

import { getTranslations } from 'next-intl/server'
import { page, pageHeader, ref, widget, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import {
  comparablePayRuns,
  comparableSlots,
  parallelComparisons,
  parallelTolerances,
  priorRegisters,
} from '@openbooks/engine/src/payroll-parallel-run-store.ts'
import { can, requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { groupTabs } from '../../../../components/module-home/group-tabs'
import type { ParallelRunView } from './ParallelRunView'

/**
 * Parallel run — the adoption control, split into a loader and a spec.
 *
 * This page is a fully client-interactive workspace: two picker selects with
 * derived defaults, a compare POST with toast feedback, a findings drawer
 * that lazy-loads over fetch, and a tolerance editor drawer with its own
 * POST/DELETE cycle. None of that is spec vocabulary — the drawer is data
 * fetched on open (not a `?comparison=` flyout), the pickers are component
 * state (not URL params), and the compare/tolerance/discard actions are
 * bound fetch calls, not named routes. Decomposing the tables into `table`
 * blocks would split one component's state across two render paths and
 * reimplement its conditional pairs (link-when-published style status and
 * result badges, zero-vs-nonzero difference cells, null-amount cells) as
 * spec constructs that do not exist.
 *
 * So the spec places the workspace whole through one widget, the same call
 * the pay-run wizard page made: `ParallelRunView` moves nowhere and is
 * shared by the page and the widget registry. The loader below copies page.tsx verbatim —
 * the `payroll.read` gate, the `payroll` feature gate (404 when disabled),
 * the five store reads, the module tabs, and the `payroll.manage` flag —
 * and hands the store rows to the widget untouched.
 *
 * Money, dates and counts are NOT formatted here. The native component
 * formats them client-side (`useMoney` is browser-locale; `comparedAt` is
 * sliced in the cell), so the loader passes the canonical store values
 * through and the component does what it always did.
 */

type WorkspaceProps = Parameters<typeof ParallelRunView>[0]

export interface ParallelRunData {
  title: string
  description: string
  viewTabs: { href: string; label: string; active?: boolean }[]
  workspace: {
    registers: WorkspaceProps['registers']
    runs: WorkspaceProps['runs']
    comparisons: WorkspaceProps['comparisons']
    tolerances: WorkspaceProps['tolerances']
    slots: WorkspaceProps['slots']
    canManage: boolean
  }
}

export async function loadParallelRun(
  _sp: Record<string, string | string[] | undefined>,
): Promise<ParallelRunData> {
  const authz = await requirePermission('payroll.read')
  const orgId = authz.user.orgId
  await requireFeatureEnabled(orgId, 'payroll')

  const t = await getTranslations('payroll')
  const text = (key: string, fallback: string) =>
    t.has(key as never) ? t(key as never) : fallback

  const [registers, runs, comparisons, tolerances, slots] = await Promise.all([
    priorRegisters(orgId),
    comparablePayRuns(orgId),
    parallelComparisons(orgId, {}),
    parallelTolerances(orgId),
    comparableSlots(orgId),
  ])
  const tabs = await groupTabs('payroll', '/payroll/parallel-run', { orgId })

  return {
    title: text('parallelRun.title', 'Parallel run'),
    description: text(
      'parallelRun.description',
      'Check a pay period against the payroll system you are leaving, penny by penny. Import the old provider’s register, pick the run that covers the same period, and compare.',
    ),
    viewTabs: tabs,
    workspace: {
      registers,
      runs,
      comparisons,
      tolerances,
      slots: slots.map((slot) => ({
        fieldKey: slot.fieldKey,
        kind: slot.kind,
        slot: slot.slot,
        label: slot.label,
      })),
      canManage: can(authz, 'payroll.manage'),
    },
  }
}

const f = ref<ParallelRunData>()

export function parallelRunSpec(_data: ParallelRunData): PageSpec {
  return page({
    route: '/payroll/parallel-run',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actions: [widget('module-home-tabs', { tabs: _data.viewTabs })],
      }),
    ],
    body: [
      // The whole workspace — compare controls, both PagedTables, the
      // findings drawer and the tolerance drawer — placed through one
      // widget. The component owns picker state, fetch mutations and every
      // conditional pair; the spec only names where it lives.
      widgetBlock('parallel-run-workspace', {
        registers: f('workspace.registers'),
        runs: f('workspace.runs'),
        comparisons: f('workspace.comparisons'),
        tolerances: f('workspace.tolerances'),
        slots: f('workspace.slots'),
        canManage: f('workspace.canManage'),
      }),
    ],
  })
}

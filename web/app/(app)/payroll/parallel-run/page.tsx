import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@openbooks/ui'
import {
  comparablePayRuns,
  comparableSlots,
  parallelComparisons,
  parallelTolerances,
  priorRegisters,
} from '@openbooks/engine/src/payroll-parallel-run-store.ts'
import { ListPageLayout } from '../../../../components/page-layout'
import { groupTabs } from '../../../../components/module-home/group-tabs'
import { ModuleHomeTabs } from '../../../../components/module-home/ui'
import { can, requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { ParallelRunView } from './ParallelRunView'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('payroll')
  return {
    title: t.has('parallelRun.title' as never) ? t('parallelRun.title' as never) : 'Parallel run',
  }
}

/**
 * Parallel run — the adoption control.
 *
 * Nobody moves payroll without running both systems side by side for a period
 * or two and proving every number, and until now that was a spreadsheet. This
 * screen is the operator's side of it: pick the register imported from the
 * outgoing provider, pick the run to check it against, compare, and drill into
 * an employee's differences.
 *
 * It lives in the PAYROLL module rather than on the /admin/setup rail for the
 * same reasons opening balances do — it is per-employee compensation data with
 * its own lifecycle, gated on payroll's own permissions. Files come in through
 * the shared import wizard (/data/import, resource "Prior payroll register");
 * the tabular output is a REAL report (Reports → Parallel run reconciliation)
 * with the native filter bar, saved views, PDF/Excel/CSV and scheduling. This
 * page is the workspace that runs the comparison and reads its exceptions.
 */
export default async function PayrollParallelRunPage() {
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
  const tabs = await groupTabs('payroll', '/payroll/parallel-run')

  return (
    <ListPageLayout
      header={
        <PageHeader
          title={text('parallelRun.title', 'Parallel run')}
          description={text(
            'parallelRun.description',
            'Check a pay period against the payroll system you are leaving, penny by penny. Import the old provider’s register, pick the run that covers the same period, and compare.',
          )}
          actions={<ModuleHomeTabs tabs={tabs} />}
        />
      }
    >
      <ParallelRunView
        registers={registers}
        runs={runs}
        comparisons={comparisons}
        tolerances={tolerances}
        slots={slots.map((slot) => ({
          fieldKey: slot.fieldKey, kind: slot.kind, slot: slot.slot, label: slot.label,
        }))}
        canManage={can(authz, 'payroll.manage')}
      />
    </ListPageLayout>
  )
}

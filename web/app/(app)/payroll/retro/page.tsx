import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { groupTabs } from '../../../../components/module-home/group-tabs'
import { ModuleHomeTabs } from '../../../../components/module-home/ui'
import { can, requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { scopedRetroSchedules } from '../../../../lib/payroll-scoped-views'
import { RetroWorkspace, type RetroSchedule } from './RetroWorkspace'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadPayrollRetro, payrollRetroSpec } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('payroll')
  return {
    title: t.has('retro.title' as never) ? t('retro.title' as never) : 'Retroactive pay',
  }
}

/**
 * Retroactive pay — the workspace.
 *
 * A union agreement settles in March with a wage increase effective the
 * previous 1 January; ten periods have gone out at the old rate. This screen is
 * the four steps in order: find the periods whose inputs have moved since they
 * were paid, recalculate each one through the pay run's own engine, show the
 * operator old / new / already-settled / difference per employee per period,
 * and hand a draft retro pay run to the ordinary wizard.
 *
 * It lives in the PAYROLL module beside the parallel run and opening balances,
 * for the same reason: it is per-employee compensation work with its own
 * lifecycle and its own permission, not org configuration. The money it
 * produces is paid, taxed, costed and posted by the standard pay-run pipeline —
 * this page adds no second path to a cheque.
 */
export default async function PayrollRetroPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  if ((await searchParams).__viewspec === '1') {
    const sp = await searchParams
    const data = await loadPayrollRetro(sp)
    return (
      <>
        {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
        <meta name="x-viewspec-render" content="1" />
        <ModuleView spec={payrollRetroSpec(data)} data={data} searchParams={sp} trusted />
      </>
    )
  }
  const authz = await requirePermission('payroll.read')
  const orgId = authz.user.orgId
  await requireFeatureEnabled(orgId, 'payroll')

  const t = await getTranslations('payroll')
  const text = (key: string, fallback: string) =>
    t.has(key as never) ? t(key as never) : fallback

  const schedules: RetroSchedule[] = await scopedRetroSchedules(authz)

  const tabs = await groupTabs('payroll', '/payroll/retro', { orgId })

  return (
    <ListPageLayout
      header={
        <PageHeader
          title={text('retro.title', 'Retroactive pay')}
          description={text(
            'retro.description',
            'A raise backdated over periods that have already been paid. Recalculate each of those periods, see what it should have paid against what it did, and pay the difference — taxed as the jurisdiction requires and costed to the jobs the hours were charged to.',
          )}
          actions={<ModuleHomeTabs tabs={tabs} />}
        />
      }
    >
      <RetroWorkspace schedules={schedules} canRun={can(authz, 'payroll.run')} />
    </ListPageLayout>
  )
}

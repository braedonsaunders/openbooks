import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { PageHeader } from '@openbooks/ui'
import { db } from '@openbooks/engine/src/db.ts'
import { ListPageLayout } from '../../../../components/page-layout'
import { groupTabs } from '../../../../components/module-home/group-tabs'
import { ModuleHomeTabs } from '../../../../components/module-home/ui'
import { can, requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { RetroWorkspace, type RetroSchedule } from './RetroWorkspace'

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
export default async function PayrollRetroPage() {
  const authz = await requirePermission('payroll.read')
  const orgId = authz.user.orgId
  await requireFeatureEnabled(orgId, 'payroll')

  const t = await getTranslations('payroll')
  const text = (key: string, fallback: string) =>
    t.has(key as never) ? t(key as never) : fallback

  const schedules = (await db.execute<RetroSchedule>(sql`
    select s.id, s.name
      from pay_schedules s
     where s.org_id = ${orgId} and s.is_active
       -- Only a schedule that has actually paid something can owe retro.
       and exists (
         select 1 from pay_runs r
          where r.org_id = s.org_id and r.pay_schedule_id = s.id
            and r.run_status = 'committed')
     order by s.name
  `))

  const tabs = await groupTabs('payroll', '/payroll/retro')

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
      <RetroWorkspace schedules={schedules.rows} canRun={can(authz, 'payroll.run')} />
    </ListPageLayout>
  )
}

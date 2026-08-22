import { getTranslations } from 'next-intl/server'
import Link from 'next/link'
import { ArrowUpRight } from 'lucide-react'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { groupTabs } from '../../../../components/module-home/group-tabs'
import { ModuleHomeTabs } from '../../../../components/module-home/ui'
import { RecordListView } from '../../../../components/record-list-view'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
import { requirePermission, can } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { NewRunButton } from '../_ui/NewRunButton'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('payroll')
  return { title: t('list.title') }
}

/**
 * Pay runs — the universal RecordListView over documents kind 'pay_run'
 * (search, merged-lifecycle stage chips, schedule + date-range filters, saved
 * views, sortable typed columns, pagination). Rows open the pay-run wizard —
 * a full page, not a drawer — via the list source's link override.
 */
export default async function PayRunsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('payroll.read')
  const orgId = authz.user.orgId
  await requireFeatureEnabled(orgId, 'payroll')
  const canRun = can(authz, 'payroll.run')
  const t = await getTranslations('payroll')
  const sp = await searchParams

  const schedules = canRun
    ? (((await db.execute<{ id: string; name: string; frequency: string; pay_date_offset_days: number; last_end: string | null }>(sql`
        select s.id, s.name, s.frequency, s.pay_date_offset_days,
               coalesce(max(r.period_end), s.anchor_period_end)::text as last_end
          from pay_schedules s
          left join pay_runs r on r.pay_schedule_id = s.id and r.org_id = s.org_id
         where s.org_id = ${orgId} and s.is_active
         group by s.id, s.name, s.frequency, s.pay_date_offset_days, s.anchor_period_end
         order by s.name`))).rows)
    : []

  // A final pay run must NAME the employees it pays (it clears every accrued
  // bank), and the engine will only calculate one for people whose employment
  // has ended — so the picker offers exactly those.
  const finalPayCandidates = canRun
    ? (((await db.execute<{ id: string; name: string; pay_schedule_id: string; terminated_on: string }>(sql`
        select distinct on (prof.employee_party_id)
               prof.employee_party_id as id, p.display_name as name,
               prof.pay_schedule_id, er.terminated_on::text as terminated_on
          from employee_payroll_profiles prof
          join parties p on p.id = prof.employee_party_id and p.org_id = prof.org_id
          join employee_roles er on er.party_id = p.id and er.org_id = p.org_id
         where prof.org_id = ${orgId} and prof.is_active and er.terminated_on is not null
         order by prof.employee_party_id, er.terminated_on desc`))).rows)
    : []

  const newButton = canRun
    ? <NewRunButton schedules={schedules} finalPayCandidates={finalPayCandidates} today={await businessToday(orgId)} />
    : undefined

  const moduleTabs = await groupTabs('payroll', '/payroll/runs')

  return (
    <ListPageLayout
      header={
        <PageHeader
          title={t('list.title')}
          description={t('list.description')}
          actions={
            <div className="flex items-center gap-3">
              {newButton}
              <ModuleHomeTabs tabs={moduleTabs} />
            </div>
          }
        />
      }
    >
      <RecordListView
        recordType="pay_run"
        basePath="/payroll/runs"
        orgId={orgId}
        userId={authz.user.id}
        canManage={can(authz, 'admin.customization.manage')}
        sp={sp}
        renderRowActions={(row) => (
          <Link
            href={`/payroll/runs/${row.id}` as never}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-teal-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-teal-300"
            aria-label={t('list.open')}
            title={t('list.open')}
          >
            <ArrowUpRight size={15} />
          </Link>
        )}
      />
    </ListPageLayout>
  )
}

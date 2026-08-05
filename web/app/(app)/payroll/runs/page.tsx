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
    ? (((await db.execute(sql`
        select id, name from pay_schedules
         where org_id = ${orgId} and is_active order by name`)) as unknown as {
        rows: { id: string; name: string }[]
      }).rows)
    : []

  const newButton = canRun ? <NewRunButton schedules={schedules} /> : undefined

  const moduleTabs = await groupTabs('payroll', '/payroll/runs')

  return (
    <ListPageLayout
      header={
        <PageHeader
          title={t('list.title')}
          description={t('list.description')}
          back={{ href: '/payroll', label: t('title') }}
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
        emptyAction={newButton}
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

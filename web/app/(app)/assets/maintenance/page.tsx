import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '@/components/page-layout'
import { loadMaintenance } from './_data'
import { MaintenanceWorkspace, NewScheduleButton } from './MaintenanceWorkspace'

export const dynamic = 'force-dynamic'

/** Asset maintenance: the due and overdue queue, schedules and work records. */
export default async function AssetMaintenancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const [data, t] = await Promise.all([loadMaintenance(sp), getTranslations('assets')])
  return (
    <ListPageLayout
      header={
        <PageHeader
          title={t('maintenance.title')}
          description={t('maintenance.description')}
          actions={data.canMaintain ? <NewScheduleButton data={data} /> : undefined}
        />
      }
    >
      <MaintenanceWorkspace data={data} currentParams={sp} />
    </ListPageLayout>
  )
}

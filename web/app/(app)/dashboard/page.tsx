import { getTranslations } from 'next-intl/server'
import { ModuleView } from '@/components/viewspec/module-view'
import { loadDashboard, dashboardSpec } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('dashboard')
  return { title: t('title') }
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadDashboard(sp)
  if (!data) return null
  return <ModuleView spec={dashboardSpec(data)} data={data} searchParams={sp} trusted />
}


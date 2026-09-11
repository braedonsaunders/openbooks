import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../components/viewspec/module-view'
import { loadAdminHub, adminHubSpec } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('admin')
  return { title: t('hub.metaTitle') }
}



export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadAdminHub()
  return <ModuleView spec={adminHubSpec(data)} data={data} searchParams={sp} trusted />
}

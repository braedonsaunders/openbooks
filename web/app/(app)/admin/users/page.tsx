import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadAdminUsers, adminUsersSpec } from './view'

export async function generateMetadata() {
  const t = await getTranslations('admin.users')
  return { title: t('metaTitle') }
}
export const dynamic = 'force-dynamic'


export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadAdminUsers(sp)
  return <ModuleView spec={adminUsersSpec(data)} data={data} searchParams={sp} trusted />
}

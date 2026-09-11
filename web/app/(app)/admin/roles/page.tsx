import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadAdminRoles, adminRolesSpec } from './view'

export async function generateMetadata() {
  const t = await getTranslations('admin.roles')
  return { title: t('metaTitle') }
}
export const dynamic = 'force-dynamic'


export default async function AdminRolesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadAdminRoles(sp)
  return <ModuleView spec={adminRolesSpec(data)} data={data} searchParams={sp} trusted />
}

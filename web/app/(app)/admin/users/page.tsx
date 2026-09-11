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
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={adminUsersSpec(data)} data={data} searchParams={sp} trusted />
    </>
  )
}

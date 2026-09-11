import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadAdminApps, adminAppsSpec } from './view'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export default async function AppsAdminPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadAdminApps(sp)
  return <ModuleView spec={adminAppsSpec(data)} data={data} searchParams={sp} trusted />
}

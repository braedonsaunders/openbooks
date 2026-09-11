import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadNavigationAdmin, navigationAdminSpec } from './view'

export const dynamic = 'force-dynamic'

export default async function NavigationAdmin({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadNavigationAdmin(sp)
  if (!data) return null
  return <ModuleView spec={navigationAdminSpec(data)} data={data} searchParams={sp} trusted />
}

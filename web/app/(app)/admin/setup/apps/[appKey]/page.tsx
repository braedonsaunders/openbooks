import { ModuleView } from '../../../../../../components/viewspec/module-view'
import { appSettingsSpec, loadAppSettings } from './view'

export const dynamic = 'force-dynamic'

export default async function AppSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ appKey: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { appKey } = await params
  const sp = await searchParams
  const data = await loadAppSettings(appKey, sp)
  return <ModuleView spec={appSettingsSpec(data)} data={data} searchParams={sp} trusted />
}

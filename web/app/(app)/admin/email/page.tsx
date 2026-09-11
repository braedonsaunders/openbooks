import { ModuleView } from '../../../../components/viewspec/module-view'
import { emailSettingsSpec, loadEmailSettings } from './view'

export const dynamic = 'force-dynamic'

export default async function EmailSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadEmailSettings()
  return <ModuleView spec={emailSettingsSpec(data)} data={data} searchParams={sp} trusted />
}

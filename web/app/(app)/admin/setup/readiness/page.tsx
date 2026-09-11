import { ModuleView } from '../../../../../components/viewspec/module-view'
import { loadSetupReadiness, setupReadinessSpec } from './view'

export const dynamic = 'force-dynamic'


export default async function SetupReadinessPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadSetupReadiness()
  return <ModuleView spec={setupReadinessSpec(data)} data={data} searchParams={sp} trusted />
}

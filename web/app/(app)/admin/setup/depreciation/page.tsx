import { ModuleView } from '../../../../../components/viewspec/module-view'
import { loadDepreciationSetup, depreciationSetupSpec } from './view'

export const dynamic = 'force-dynamic'


export default async function DepreciationSetupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadDepreciationSetup(sp)
  return <ModuleView spec={depreciationSetupSpec(data)} data={data} searchParams={sp} trusted />
}

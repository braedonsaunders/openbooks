import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadNonprofitSetup, nonprofitSetupSpec } from './view'

export const dynamic = 'force-dynamic'

export default async function NonprofitSetup() {
  const data = await loadNonprofitSetup()
  return <ModuleView spec={nonprofitSetupSpec(data)} data={data} searchParams={{}} trusted />
}

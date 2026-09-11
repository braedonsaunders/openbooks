import { ModuleView } from '../../../../../components/viewspec/module-view'
import { loadTaxDepreciationSetup, taxDepreciationSetupSpec } from './view'

export const dynamic = 'force-dynamic'


export default async function TaxDepreciationSetupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadTaxDepreciationSetup(sp)
  return <ModuleView spec={taxDepreciationSetupSpec(data)} data={data} searchParams={sp} trusted />
}

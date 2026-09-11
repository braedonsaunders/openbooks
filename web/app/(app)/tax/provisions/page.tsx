import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadTaxProvisions, taxProvisionsSpec } from './view'

export const dynamic = 'force-dynamic'


export default async function TaxProvisions({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadTaxProvisions(sp)
  return <ModuleView spec={taxProvisionsSpec(data)} data={data} searchParams={sp} trusted />
}

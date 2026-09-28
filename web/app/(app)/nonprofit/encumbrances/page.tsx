import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadEncumbrances, encumbrancesSpec } from './view'

export const dynamic = 'force-dynamic'

export default async function Encumbrances({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadEncumbrances(sp)
  return <ModuleView spec={encumbrancesSpec(data)} data={data} searchParams={sp} trusted />
}

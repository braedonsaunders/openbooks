import { ModuleView } from '../../../../../components/viewspec/module-view'
import { loadManufacturingSetup, manufacturingPoliciesSpec } from './view'
import { ManufacturingPoliciesForm } from './sections'

export const dynamic = 'force-dynamic'

export default async function ManufacturingSetup({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadManufacturingSetup()
  return (
    <div className="space-y-4">
      <ModuleView spec={manufacturingPoliciesSpec(data)} data={data} searchParams={sp} trusted />
      <ManufacturingPoliciesForm initial={data.policies} />
    </div>
  )
}

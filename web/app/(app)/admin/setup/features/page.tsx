import { ModuleView } from '../../../../../components/viewspec/module-view'
import { featuresSpec, loadFeatures } from './view'

export const dynamic = 'force-dynamic'

/**
 * Features — the on/off switchboard for optional modules. Not every company
 * uses every feature; off = hidden from nav, routes 404, setup surfaces hide.
 * Data is never deleted by toggling.
 */
export default async function FeaturesSetup({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadFeatures()
  return <ModuleView spec={featuresSpec(data)} data={data} searchParams={sp} trusted />
}

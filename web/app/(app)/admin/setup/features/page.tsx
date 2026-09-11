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
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={featuresSpec(data)} data={data} searchParams={sp} trusted />
    </>
  )
}

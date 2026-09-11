import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadOpportunities, opportunitiesSpec } from './view'

export const dynamic = 'force-dynamic'

/**
 * Opportunities use the universal entity-list renderer. This page owns only
 * the title/create action and the opportunity-specific editor payload.
 */
export default async function Opportunities({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadOpportunities(sp)
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={opportunitiesSpec(data)} data={data} searchParams={sp} trusted />
    </>
  )
}

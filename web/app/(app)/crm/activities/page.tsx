import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadActivities, activitiesSpec } from './view'

export const dynamic = 'force-dynamic'

export default async function Activities({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadActivities(sp)
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={activitiesSpec(data)} data={data} searchParams={sp} trusted />
    </>
  )
}

import { ModuleView } from '../../../../../components/viewspec/module-view'
import { insightsDashboardSpec, loadInsightsDashboard } from './view'

export const dynamic = 'force-dynamic'

export default async function DashboardDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  // Optional: this route natively takes only `params`.
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = (await searchParams) ?? {}
  const { id } = await params
  const data = await loadInsightsDashboard(id)
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={insightsDashboardSpec(data)} data={data} searchParams={sp} trusted />
    </>
  )
}

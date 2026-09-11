import { ModuleView } from '../../../../../../components/viewspec/module-view'
import { loadReportRun, reportRunSpec } from './view'

export const dynamic = 'force-dynamic'

/**
 * A saved query report IS a regular report: this screen is the exact native
 * report chrome — header back to the hub, filter-bar row with Export, and the
 * paper, already run. Definition management (builder, delivery schedules, run
 * history) lives on its own screens, never here.
 */
export default async function ReportRunPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const { id } = await params
  const data = await loadReportRun(id, sp)
  return <ModuleView spec={reportRunSpec(data)} data={data} searchParams={sp} trusted />
}

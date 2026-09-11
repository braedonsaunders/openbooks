import { ModuleView } from '../../../../../../../components/viewspec/module-view'
import { loadReportDelivery, reportDeliverySpec } from './view'

export const dynamic = 'force-dynamic'

/**
 * Delivery management for one saved report: e-mail schedules and the recorded
 * run history with artifacts. Kept off the report screen itself — that page is
 * pure native report chrome.
 */
export default async function ReportDeliveryPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  // Optional: this route natively takes only `params`.
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = (await searchParams) ?? {}
  const { id } = await params
  const data = await loadReportDelivery(id)
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={reportDeliverySpec(data)} data={data} searchParams={sp} trusted />
    </>
  )
}

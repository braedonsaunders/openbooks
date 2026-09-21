import { ModuleView } from '../../../../components/viewspec/module-view'
import { complianceSpec, complianceTitle, loadCompliancePageData } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { title: await complianceTitle() }
}

/**
 * The Compliance tab (HR-13). Findings with kind segments, rate
 * schedules, certified runs, comp classes and per-diem entries — renders
 * only when the hrmConstructionCompliance switch is on and the actor
 * holds hrm.construction.read; the view 404s otherwise.
 */
export default async function CompliancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await loadCompliancePageData(sp)
  return <ModuleView spec={complianceSpec(data, '/hrm/compliance')} data={data} searchParams={sp} trusted />
}

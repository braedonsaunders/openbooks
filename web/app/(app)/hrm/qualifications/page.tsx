import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadQualificationsPage, qualificationsSpec, qualificationsTitle } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { title: await qualificationsTitle() }
}

/**
 * The worker qualification ledger — the Qualifications tab. Stat tiles
 * for expiring, expired-and-assigned, pending, and unmet projects; the
 * ledger table by worker with status and type filter chips; a drawer
 * per qualification with evidence and events; sub-tabs for Requirements
 * (with the crew coverage matrix) and Alerts. Renders only when the
 * hrmCertifications feature gate is on and the actor holds
 * hrm.certifications.read — the view 404s otherwise.
 */
export default async function QualificationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await loadQualificationsPage(sp)
  return <ModuleView spec={qualificationsSpec(data)} data={data} searchParams={sp} trusted />
}

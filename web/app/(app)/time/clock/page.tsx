import { ModuleView } from '../../../../components/viewspec/module-view'
import { clockSpec, clockTitle, loadClockPage } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { title: await clockTitle() }
}

/**
 * The field clock page — the phone is the primary device. Renders only
 * when the fieldTime feature is on and the actor holds time.clock —
 * the view 404s otherwise, so office orgs never see a clock.
 */
export default async function ClockPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await loadClockPage()
  return <ModuleView spec={clockSpec(data)} data={data} searchParams={sp} trusted />
}

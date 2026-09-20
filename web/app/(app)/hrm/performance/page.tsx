import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadPerformancePage, performanceSpec, performanceTitle } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { title: await performanceTitle() }
}

/**
 * Performance tab: review cycles with progress, the cycle drawer with its
 * reviews and calibration island, the review drawer with the snapshot
 * answer form and goals, the self-service "My reviews" segment, and the
 * Retention panel for HR. Renders for any authenticated viewer when the
 * hrm feature gate is on — the read service narrows every row to the
 * actor's privacy scope, so a manager with reports and no grant still gets
 * the tab showing only their reviews.
 */
export default async function PerformancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await loadPerformancePage(sp)
  return <ModuleView spec={performanceSpec(data)} data={data} searchParams={sp} trusted />
}

import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadMeOneOnOnesPage, meOneOnOnesSpec, meOneOnOnesTitle } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { title: await meOneOnOnesTitle() }
}

/**
 * Me 1:1s — upcoming and past conversations with the agenda drawer, plus
 * open feedback requests with the fulfil form. Renders only when hrm,
 * hrmPerformance and hrmOneOnOnes are on — the view 404s otherwise.
 */
export default async function MeOneOnOnesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await loadMeOneOnOnesPage(sp)
  return <ModuleView spec={meOneOnOnesSpec(data)} data={data} searchParams={sp} trusted />
}

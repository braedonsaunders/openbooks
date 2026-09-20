import { ModuleView } from '../../../../components/viewspec/module-view'
import { myCompSpec, myCompTitle, loadMyCompPage } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { title: await myCompTitle() }
}

/**
 * My compensation — placement, statements, and the pay-information
 * request. Renders only when hrmCompensation is on and the person has
 * a band or a statement.
 */
export default async function MyCompensationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await loadMyCompPage(sp)
  return <ModuleView spec={myCompSpec(data)} data={data} searchParams={sp} trusted />
}

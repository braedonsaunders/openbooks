import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadReleases, releasesSpec } from './view'

export const dynamic = 'force-dynamic'

export default async function Releases({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadReleases(sp)
  return <ModuleView spec={releasesSpec(data)} data={data} searchParams={sp} trusted />
}

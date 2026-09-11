import { ModuleView } from '../../../components/viewspec/module-view'
import { loadAssets, assetsSpec } from './view'

export const dynamic = 'force-dynamic'

export default async function Assets({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadAssets(sp)
  return <ModuleView spec={assetsSpec(data)} data={data} searchParams={sp} trusted />
}

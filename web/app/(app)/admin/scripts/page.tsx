import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadScripts, scriptsSpec } from './view'

export const dynamic = 'force-dynamic'

export default async function Scripts({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadScripts(sp)
  return <ModuleView spec={scriptsSpec(data)} data={data} searchParams={sp} trusted />
}

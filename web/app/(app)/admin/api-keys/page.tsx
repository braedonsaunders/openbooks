import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadApiKeys, apiKeysSpec } from './view'

export const dynamic = 'force-dynamic'

export default async function ApiKeysPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadApiKeys(sp)
  return <ModuleView spec={apiKeysSpec(data)} data={data} searchParams={sp} trusted />
}

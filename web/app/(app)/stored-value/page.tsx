import { ModuleView } from '../../../components/viewspec/module-view'
import { loadStoredValuePage, storedValueSpec } from './view'

export const dynamic = 'force-dynamic'

/**
 * Customers → Stored value. Gift cards and store credit carried as a
 * liability: KPIs, the masked-code register, and one drawer per account.
 */
export default async function StoredValuePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadStoredValuePage(sp)
  return <ModuleView spec={storedValueSpec(data)} data={data} searchParams={sp} trusted />
}

import { ModuleView } from '../../../components/viewspec/module-view'
import { internalBillingSpec, loadInternalBillingPage } from './view'

export const dynamic = 'force-dynamic'

/**
 * Internal billing — departments, projects and subsidiaries billing one
 * another under effective-dated rules. Gated by Company Settings → Features
 * → Internal billing.
 */
export default async function InternalBillingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadInternalBillingPage(sp)
  return <ModuleView spec={internalBillingSpec(data)} data={data} searchParams={sp} trusted />
}

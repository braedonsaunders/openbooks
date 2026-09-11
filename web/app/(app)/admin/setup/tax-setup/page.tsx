import { ModuleView } from '../../../../../components/viewspec/module-view'
import { loadTaxSetup, taxSetupSpec } from './view'

export const dynamic = 'force-dynamic'

/**
 * Tax Setup — the top-level guided workspace for standing up indirect-tax
 * compliance, promoted out of the buried Tax Returns library drawer to sit
 * beside Overhead Model and Labor Costing. Install a country pack and it creates
 * that jurisdiction, its return form and boxes; the guide then walks the user
 * on to declaring nexus (where they're registered) and reviewing tax codes.
 */
export default async function TaxSetupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadTaxSetup(sp)
  return <ModuleView spec={taxSetupSpec(data)} data={data} searchParams={sp} trusted />
}

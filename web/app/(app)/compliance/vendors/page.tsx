import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadComplianceVendors, complianceVendorsSpec } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('compliance')
  return { title: t('vendors.title') }
}

/**
 * The subcontractor compliance matrix: one row per classified vendor, one cell
 * per policy that applies to it. The grid is the point — a per-vendor list makes
 * it impossible to see that nine subs all let the same certificate lapse.
 *
 * Every cell is the SAME evaluation the payment engine performs, so a green row
 * here is a promise the pay run will keep.
 */
export default async function ComplianceVendorsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadComplianceVendors(sp)
  return <ModuleView spec={complianceVendorsSpec(data)} data={data} searchParams={sp} trusted />
}

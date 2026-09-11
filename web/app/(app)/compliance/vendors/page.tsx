import { getTranslations } from 'next-intl/server'
import {
} from '@openbooks/ui'
import {
} from '../../../../lib/compliance'
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
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={complianceVendorsSpec(data)} data={data} searchParams={sp} trusted />
    </>
  )
}

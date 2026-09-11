import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadVendorPerformance, vendorPerformanceSpec } from './view'
import { getTranslations } from 'next-intl/server'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('analytics.vendor')
  return { title: t('title') }
}

export default async function VendorPerformancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await loadVendorPerformance(sp)
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={vendorPerformanceSpec(data)} data={data} searchParams={sp} trusted />
    </>
  )
}

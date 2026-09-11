import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadCustomerIntelligence, customerIntelligenceSpec } from './view'
import { getTranslations } from 'next-intl/server'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('analytics.customer')
  return { title: t('title') }
}

export default async function CustomerIntelligencePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await loadCustomerIntelligence(sp)
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={customerIntelligenceSpec(data)} data={data} searchParams={sp} trusted />
    </>
  )
}

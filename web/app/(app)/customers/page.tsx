import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../components/viewspec/module-view'
import { loadCustomers, customersSpec } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('customers')
  return { title: t('home.title') }
}

/**
 * Customers module home — the relationship-to-cash workspace landing the nav
 * group header opens. The top open-balance relationships are the hero; the
 * rail carries the 13-week collections trend, the live directory, and the
 * needs-attention queue. Tabs are ROUTES (the /ap idiom): the AR cockpit
 * stays its own page and appears here as a sibling tab when the org's nav
 * shows it.
 */
export default async function CustomersHomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await loadCustomers(sp)
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={customersSpec(data)} data={data} searchParams={sp} trusted />
    </>
  )
}



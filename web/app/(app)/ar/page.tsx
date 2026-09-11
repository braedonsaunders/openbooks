import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../components/viewspec/module-view'
import { loadArCockpit, arCockpitSpec } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('ar')
  return { title: t('cockpit.title') }
}

/**
 * Accounts Receivable — the receivables control center (vitals + collections
 * worklist + aging), the AP page's mirror. The invoice list is its own
 * first-class route at /ar/invoices.
 */
// The whole props object is optional: an integration test renders this page
// component directly with no arguments, and a bare destructure would make
// that a type error.
export default async function AR({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
} = {}) {
  const sp0 = (await searchParams) ?? {}
  const data = await loadArCockpit()
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={arCockpitSpec(data)} data={data} searchParams={sp0} trusted />
    </>
  )
}

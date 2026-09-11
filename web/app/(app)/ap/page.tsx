import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../components/viewspec/module-view'
import { loadApCockpit, apCockpitSpec } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('ap')
  return { title: t('cockpit.title') }
}

/**
 * Accounts Payable — the payables control center (vitals + pay-run planner +
 * aging). The bills list is its own first-class route at /ap/bills.
 */
// `searchParams` is OPTIONAL because cash-scope.integration.test.ts calls
// this component directly with no arguments — the same accommodation /ar
// needed. A required prop here turns a passing test into a type error.
export default async function AP({
  searchParams = Promise.resolve({}),
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
} = {}) {
  const sp = await searchParams
  const data = await loadApCockpit()
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={apCockpitSpec(data)} data={data} searchParams={sp} trusted />
    </>
  )
}

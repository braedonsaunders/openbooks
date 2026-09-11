import { getTranslations } from 'next-intl/server'
import {
} from '@openbooks/ui'
import {
} from '../../../../lib/compliance'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadInformationReturns, informationReturnsSpec } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('compliance')
  return { title: t('informationReturns.title') }
}


/**
 * Information-return filings by year. One row per (year, form, filing entity),
 * with the readiness queue underneath — the list of vendors that will make a
 * filing wrong if nobody chases them before January.
 */
export default async function InformationReturnsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | undefined>>
} = {}) {
  const sp = (await searchParams) ?? {}
  const data = await loadInformationReturns()
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={informationReturnsSpec(data)} data={data} searchParams={sp} trusted />
    </>
  )
}

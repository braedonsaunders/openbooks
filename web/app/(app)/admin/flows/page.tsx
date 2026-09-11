import { getTranslations } from 'next-intl/server'
import {
} from '@openbooks/ui'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadFlows, flowsSpec } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('admin.flows')
  return { title: t('title') }
}


export default async function Flows({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadFlows(sp)
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={flowsSpec(data)} data={data} searchParams={sp} trusted />
    </>
  )
}

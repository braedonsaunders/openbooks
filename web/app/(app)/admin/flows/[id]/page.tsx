import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../../../components/viewspec/module-view'
import { flowBuilderSpec, loadFlowBuilder } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('admin.flows')
  return { title: t('title') }
}

export default async function FlowBuilderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  // Optional: this route natively takes only `params`.
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const { id } = await params
  const sp = (await searchParams) ?? {}
  const data = await loadFlowBuilder(id)
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={flowBuilderSpec(data)} data={data} searchParams={sp} trusted />
    </>
  )
}

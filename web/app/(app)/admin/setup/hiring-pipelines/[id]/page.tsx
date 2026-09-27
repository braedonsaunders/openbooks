import { ModuleView } from '../../../../../../components/viewspec/module-view'
import { loadPipelineBuilder, pipelineBuilderSpec } from './view'

export const dynamic = 'force-dynamic'

export default async function PipelineBuilderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const { id } = await params
  const sp = (await searchParams) ?? {}
  const data = await loadPipelineBuilder(id)
  return <ModuleView spec={pipelineBuilderSpec(data)} data={data} searchParams={sp} trusted />
}

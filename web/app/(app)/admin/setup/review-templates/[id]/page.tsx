import { ModuleView } from '../../../../../../components/viewspec/module-view'
import { loadReviewTemplateBuilder, reviewTemplateBuilderSpec } from './view'

export const dynamic = 'force-dynamic'

export default async function ReviewTemplateBuilderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const { id } = await params
  const sp = (await searchParams) ?? {}
  const data = await loadReviewTemplateBuilder(id)
  return <ModuleView spec={reviewTemplateBuilderSpec(data)} data={data} searchParams={sp} trusted />
}

import { ModuleView } from '../../../../../components/viewspec/module-view'
import { loadReviewTemplates, reviewTemplatesSpec } from './view'

export const dynamic = 'force-dynamic'

export default async function ReviewTemplatesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadReviewTemplates(sp)
  return <ModuleView spec={reviewTemplatesSpec(data)} data={data} searchParams={sp} trusted />
}

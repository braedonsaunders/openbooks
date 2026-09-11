// One definition of the page size and the client-side pager, shared by both
// render paths.
import { ModuleView } from '../../../../../components/viewspec/module-view'
import { loadSavedViewRun, savedViewRunSpec } from './view'

export const dynamic = 'force-dynamic'

export default async function ViewRunPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp0 = await searchParams
  const data = await loadSavedViewRun(await params, sp0)
  return <ModuleView spec={savedViewRunSpec(data)} data={data} searchParams={sp0} trusted />
}

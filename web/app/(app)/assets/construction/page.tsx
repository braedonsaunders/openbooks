import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadConstruction } from './_data'
import { constructionSpec } from './view'

export const dynamic = 'force-dynamic'

/**
 * Construction in progress: records accumulating linked GL cost, their
 * governed capitalization into assets, and the subledger's reconciliation to
 * the CIP accounts.
 */
export default async function ConstructionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadConstruction(sp)
  return <ModuleView spec={constructionSpec(data)} data={data} searchParams={sp} trusted />
}

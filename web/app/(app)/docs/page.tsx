import { ModuleView } from '../../../components/viewspec/module-view'
import { docsHomeSpec, loadDocsHome } from './view'

// Documentation home — hero + a card per category listing its articles.
export default async function DocsHomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadDocsHome()
  return <ModuleView spec={docsHomeSpec(data)} data={data} searchParams={sp} trusted />
}

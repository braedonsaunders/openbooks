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
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={docsHomeSpec(data)} data={data} searchParams={sp} trusted />
    </>
  )
}

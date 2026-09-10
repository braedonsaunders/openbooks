import { ModuleView } from '../../../components/viewspec/module-view'
import { loadQuery, querySpec } from './view'
import { QueryConsole } from './sections'

export default async function QueryConsolePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  if ((await searchParams).__viewspec === '1') {
    const sp = await searchParams
    const data = await loadQuery(sp)
    return (
      <>
        {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
        <meta name="x-viewspec-render" content="1" />
        <ModuleView spec={querySpec(data)} data={data} searchParams={sp} trusted />
      </>
    )
  }
  return <QueryConsole />
}

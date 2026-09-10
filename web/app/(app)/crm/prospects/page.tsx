import { AccountList } from '../AccountList'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadProspects, prospectsSpec } from './view'
export const dynamic = 'force-dynamic'
export default async function Prospects({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if ((await searchParams).__viewspec === '1') {
    const sp = await searchParams
    const data = await loadProspects(sp)
    return (
      <>
        {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
        <meta name="x-viewspec-render" content="1" />
        <ModuleView spec={prospectsSpec(data)} data={data} searchParams={sp} trusted />
      </>
    )
  }
  return <AccountList stage="prospect" searchParams={searchParams} />
}

import { ModuleView } from '../../../../components/viewspec/module-view'
import { AccountList } from '../AccountList'
import { loadLeads, leadsSpec } from './view'

export const dynamic = 'force-dynamic'

export default async function Leads({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  if ((await searchParams).__viewspec === '1') {
    const sp = await searchParams
    const data = await loadLeads(sp)
    return (
      <>
        {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
        <meta name="x-viewspec-render" content="1" />
        <ModuleView spec={leadsSpec(data)} data={data} searchParams={sp} trusted />
      </>
    )
  }
  return <AccountList stage="lead" searchParams={searchParams} />
}

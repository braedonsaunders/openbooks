import { ModuleView } from '../../../../../components/viewspec/module-view'
import { loadStatement, statementSpec } from './view'

export const dynamic = 'force-dynamic'


export default async function PartnerStatementPage({
  params,
  searchParams,
}: {
  params: Promise<{ partyId: string }>
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const { partyId } = await params
  const data = await loadStatement(partyId, sp)
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={statementSpec(data)} data={data} searchParams={sp} trusted />
    </>
  )
}

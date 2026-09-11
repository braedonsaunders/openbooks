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
  return <ModuleView spec={statementSpec(data)} data={data} searchParams={sp} trusted />
}

import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadGeneralLedger, generalLedgerSpec } from './view'

export const dynamic = 'force-dynamic'

export default async function GeneralLedgerPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await loadGeneralLedger(sp)
  return <ModuleView spec={generalLedgerSpec(data)} data={data} searchParams={sp} trusted />
}

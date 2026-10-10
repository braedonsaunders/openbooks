import { ModuleView } from '../../../../components/viewspec/module-view'
import { requireStatementAccess } from '../../../../lib/report-authz'
import { loadRegisters, registersSpec } from './view'

export const dynamic = 'force-dynamic'

export default async function RegistersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  // The statement's own read grant (ledger, receivables or payables), beyond reports.read.
  await requireStatementAccess('registers', sp)
  const data = await loadRegisters(sp)
  return <ModuleView spec={registersSpec(data)} data={data} searchParams={sp} trusted />
}

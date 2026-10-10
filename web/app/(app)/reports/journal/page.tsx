import { ModuleView } from '../../../../components/viewspec/module-view'
import { requireStatementAccess } from '../../../../lib/report-authz'
import { loadJournal, journalSpec } from './view'

export const dynamic = 'force-dynamic'

export default async function JournalPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  // The statement's own read grant (ledger, receivables or payables), beyond reports.read.
  await requireStatementAccess('journal', sp)
  const data = await loadJournal(sp)
  return <ModuleView spec={journalSpec(data)} data={data} searchParams={sp} trusted />
}

import { ModuleView } from '../../../components/viewspec/module-view'
import { loadJournal, journalSpec } from './view'

export const dynamic = 'force-dynamic'



export default async function Journal({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadJournal(sp)
  return <ModuleView spec={journalSpec(data)} data={data} searchParams={sp} trusted />
}

import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadAudit, auditSpec } from './view'

export const dynamic = 'force-dynamic'






export default async function Audit({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadAudit(sp)
  return <ModuleView spec={auditSpec(data)} data={data} searchParams={sp} trusted />
}

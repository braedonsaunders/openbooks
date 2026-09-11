import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadEntityRole, entityRoleSpec } from './view'

export const dynamic = 'force-dynamic'



export default async function EntityRole({
  params,
  searchParams,
}: {
  params: Promise<{ role: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const { role: slug } = await params
  const data = await loadEntityRole(slug, sp)
  return <ModuleView spec={entityRoleSpec(data)} data={data} searchParams={sp} trusted />
}

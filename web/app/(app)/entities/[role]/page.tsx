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
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={entityRoleSpec(data)} data={data} searchParams={sp} trusted />
    </>
  )
}

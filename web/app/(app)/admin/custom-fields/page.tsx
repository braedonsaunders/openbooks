import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadCustomFields, customFieldsSpec } from './view'

export const dynamic = 'force-dynamic'


export default async function CustomFields({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadCustomFields(sp)
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={customFieldsSpec(data)} data={data} searchParams={sp} trusted />
    </>
  )
}

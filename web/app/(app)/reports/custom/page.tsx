import {
} from '@openbooks/ui'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadCustomReports, customReportsSpec } from './view'

export const dynamic = 'force-dynamic'



export default async function CustomReports({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadCustomReports(sp)
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={customReportsSpec(data)} data={data} searchParams={sp} trusted />
    </>
  )
}

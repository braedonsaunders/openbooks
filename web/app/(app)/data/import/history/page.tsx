import {
} from '@openbooks/ui'
import { ModuleView } from '../../../../../components/viewspec/module-view'
import { loadImportHistory, importHistorySpec } from './view'

export const dynamic = 'force-dynamic'

export default async function ImportHistoryPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | undefined>>
}) {
  const sp = (await searchParams) ?? {}
  const data = await loadImportHistory()
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={importHistorySpec()} data={data} searchParams={sp} trusted />
    </>
  )
}

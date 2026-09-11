import {
} from '@openbooks/ui'
import {
} from '../../../../lib/records'
import {
} from '../../../../lib/record-schema'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadRecordModule, recordModuleSpec } from './view'

export const dynamic = 'force-dynamic'


/**
 * The auto-generated module for one published record type: a full list view
 * (search over the precomputed search text, per-choice-field filters,
 * sortable data columns, pagination) with the instant-draft record flyout.
 */
export default async function RecordModule({
  params,
  searchParams,
}: {
  params: Promise<{ typeKey: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const { typeKey } = await params
  const data = await loadRecordModule(sp, typeKey)
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={recordModuleSpec(data)} data={data} searchParams={sp} trusted />
    </>
  )
}

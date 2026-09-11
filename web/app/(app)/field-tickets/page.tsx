import { ModuleView } from '../../../components/viewspec/module-view'
import { loadFieldTickets, fieldTicketsSpec } from './view'

export const dynamic = 'force-dynamic'


/**
 * Field tickets — the universal RecordListView (same filters/views/columns as
 * every other list) + the standard instant-create button and transaction
 * flyout. Subordinate to the Projects parent gate on Company Settings → Features.
 */
export default async function FieldTicketsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadFieldTickets(sp)
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={fieldTicketsSpec(data)} data={data} searchParams={sp} trusted />
    </>
  )
}

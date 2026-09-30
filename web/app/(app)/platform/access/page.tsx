import { platformListSources } from '../../../../lib/list/platform-sources'
import { platformGrantOptions } from '../../../../lib/platform-admin'
import { AccessList } from './sections'

export const dynamic = 'force-dynamic'

export default async function PlatformAccessPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const source = platformListSources.access
  const { params, filter: status, result } = await source.read(sp)
  const options = await platformGrantOptions()
  return (
    <AccessList
      grants={result.rows}
      total={result.total}
      page={params.page}
      perPage={params.perPage}
      sort={params.sort}
      dir={params.dir}
      status={status}
      statusCounts={result.statusCounts}
      basePath={source.basePath}
      currentParams={sp}
      members={options.members}
      organizations={options.organizations}
      actingUsers={options.actingUsers}
    />
  )
}

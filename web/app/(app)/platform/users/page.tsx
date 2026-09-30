import { platformListSources } from '../../../../lib/list/platform-sources'
import { UsersList } from './sections'

export const dynamic = 'force-dynamic'

export default async function PlatformUsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const source = platformListSources.users
  const { params, filter: status, result } = await source.read(sp)
  return (
    <UsersList
      rows={result.rows}
      total={result.total}
      page={params.page}
      perPage={params.perPage}
      sort={params.sort}
      dir={params.dir}
      status={status}
      statusCounts={result.statusCounts}
      basePath={source.basePath}
      currentParams={sp}
    />
  )
}

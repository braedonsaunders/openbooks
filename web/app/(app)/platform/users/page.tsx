import { platformUsers } from '../../../../lib/platform-admin'
import { parseListParams, pickString } from '../../../../lib/list-params'
import { UsersList } from './sections'

export const dynamic = 'force-dynamic'

const BASE_PATH = '/platform/users'
const ALLOWED_SORTS = ['name', 'email', 'organization', 'role', 'lastLogin', 'grants'] as const
const STATUSES = ['active', 'inactive', 'super'] as const

export default async function PlatformUsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  // The house list params: sort, direction, search, status, page and page
  // size all travel on the URL, so the loader pages in SQL and every control
  // survives refreshes and shared links. The default sort stays the
  // long-standing name-ascending directory order.
  const params = parseListParams(sp, {
    sort: 'name',
    dir: 'asc',
    perPage: 50,
    allowedSorts: ALLOWED_SORTS,
  })
  const requestedStatus = pickString(sp.status)
  const status = (STATUSES as readonly string[]).includes(requestedStatus ?? '')
    ? (requestedStatus as (typeof STATUSES)[number])
    : undefined
  const result = await platformUsers({
    q: params.q,
    page: params.page,
    perPage: params.perPage,
    dir: params.dir,
    sort: params.sort,
    status,
  })
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
      basePath={BASE_PATH}
      currentParams={sp}
    />
  )
}

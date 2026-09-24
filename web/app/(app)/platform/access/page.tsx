import { platformGrantOptions, platformGrants } from '../../../../lib/platform-admin'
import { parseListParams, pickString } from '../../../../lib/list-params'
import { AccessList } from './sections'

export const dynamic = 'force-dynamic'

const BASE_PATH = '/platform/access'
const ALLOWED_SORTS = ['member', 'organization', 'actingUser', 'updated'] as const
const STATUSES = ['active', 'inactive'] as const

export default async function PlatformAccessPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  // The house list params: sort, direction, search, status, page and page
  // size all travel on the URL, so the loader pages in SQL and every control
  // survives refreshes and shared links. The default sort stays the
  // long-standing last-changed-descending grant order.
  const params = parseListParams(sp, {
    sort: 'updated',
    dir: 'desc',
    perPage: 50,
    allowedSorts: ALLOWED_SORTS,
  })
  const requestedStatus = pickString(sp.status)
  const status = (STATUSES as readonly string[]).includes(requestedStatus ?? '')
    ? (requestedStatus as (typeof STATUSES)[number])
    : undefined
  const [result, options] = await Promise.all([
    platformGrants({
      q: params.q,
      page: params.page,
      perPage: params.perPage,
      dir: params.dir,
      sort: params.sort,
      status,
    }),
    platformGrantOptions(),
  ])
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
      basePath={BASE_PATH}
      currentParams={sp}
      members={options.members}
      organizations={options.organizations}
      actingUsers={options.actingUsers}
    />
  )
}

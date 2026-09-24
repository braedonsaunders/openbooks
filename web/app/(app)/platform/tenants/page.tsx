import { platformOrganizations } from '../../../../lib/platform-admin'
import { parseListParams, pickString } from '../../../../lib/list-params'
import { TenantsList } from './sections'

export const dynamic = 'force-dynamic'

const BASE_PATH = '/platform/tenants'
const ALLOWED_SORTS = ['name', 'environment', 'users', 'sandboxes', 'created'] as const
const ENVIRONMENTS = ['production', 'sandbox', 'preview'] as const

export default async function PlatformTenantsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  // The house list params: sort, direction, search, page and page size all
  // travel on the URL, so the loader pages in SQL and every control survives
  // refreshes and shared links. The default sort stays the long-standing
  // name-ascending fleet order.
  const params = parseListParams(sp, {
    sort: 'name',
    dir: 'asc',
    perPage: 50,
    allowedSorts: ALLOWED_SORTS,
  })
  const requestedEnvironment = pickString(sp.environment)
  const environment = (ENVIRONMENTS as readonly string[]).includes(requestedEnvironment ?? '')
    ? (requestedEnvironment as (typeof ENVIRONMENTS)[number])
    : undefined
  const result = await platformOrganizations({
    q: params.q,
    page: params.page,
    perPage: params.perPage,
    dir: params.dir,
    sort: params.sort,
    environment,
  })
  return (
    <TenantsList
      rows={result.rows}
      total={result.total}
      page={params.page}
      perPage={params.perPage}
      sort={params.sort}
      dir={params.dir}
      environment={environment}
      environmentCounts={result.environmentCounts}
      basePath={BASE_PATH}
      currentParams={sp}
    />
  )
}

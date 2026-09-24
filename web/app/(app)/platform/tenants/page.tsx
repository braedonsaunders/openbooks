import { platformOrganizations } from '../../../../lib/platform-admin'
import { platformListPage } from '../../../../lib/platform-console'
import { PlatformTenantsClient } from '../_components/PlatformTenantsClient'

export const dynamic = 'force-dynamic'

export default async function PlatformTenantsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const page = platformListPage(sp)
  const perPage = 500
  const result = await platformOrganizations({
    page,
    perPage,
    dir: 'asc',
    sort: 'name',
  })
  return <PlatformTenantsClient rows={result.rows} total={result.total} page={page} perPage={perPage} basePath="/platform/tenants" params={sp} />
}

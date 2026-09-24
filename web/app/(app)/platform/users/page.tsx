import { platformUsers } from '../../../../lib/platform-admin'
import { platformListPage } from '../../../../lib/platform-console'
import { PlatformUsersClient } from '../_components/PlatformUsersClient'

export const dynamic = 'force-dynamic'

export default async function PlatformUsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const page = platformListPage(sp)
  const perPage = 500
  const result = await platformUsers({
    page,
    perPage,
    dir: 'asc',
    sort: 'name',
  })
  return <PlatformUsersClient rows={result.rows} total={result.total} page={page} perPage={perPage} basePath="/platform/users" params={sp} />
}

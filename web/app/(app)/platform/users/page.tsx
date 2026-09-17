import { platformUsers } from '../../../../lib/platform-admin'
import { PlatformUsersClient } from '../_components/PlatformUsersClient'

export const dynamic = 'force-dynamic'

export default async function PlatformUsersPage() {
  const result = await platformUsers({
    page: 1,
    perPage: 500,
    dir: 'asc',
    sort: 'name',
  })
  return <PlatformUsersClient rows={result.rows} />
}

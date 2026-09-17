import { platformOrganizations } from '../../../../lib/platform-admin'
import { PlatformTenantsClient } from '../_components/PlatformTenantsClient'

export const dynamic = 'force-dynamic'

export default async function PlatformTenantsPage() {
  const result = await platformOrganizations({
    page: 1,
    perPage: 500,
    dir: 'asc',
    sort: 'name',
  })
  return <PlatformTenantsClient rows={result.rows} />
}

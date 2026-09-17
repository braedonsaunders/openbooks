import { platformGrantOptions, platformGrants } from '../../../../lib/platform-admin'
import { PlatformAccessClient } from '../_components/PlatformAccessClient'

export const dynamic = 'force-dynamic'

export default async function PlatformAccessPage() {
  const [result, options] = await Promise.all([
    platformGrants({
      page: 1,
      perPage: 500,
      dir: 'desc',
      sort: 'updated',
    }),
    platformGrantOptions(),
  ])
  return (
    <PlatformAccessClient
      grants={result.rows}
      members={options.members}
      organizations={options.organizations}
      actingUsers={options.actingUsers}
    />
  )
}

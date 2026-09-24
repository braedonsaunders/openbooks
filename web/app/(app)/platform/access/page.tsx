import { platformGrantOptions, platformGrants } from '../../../../lib/platform-admin'
import { platformListPage } from '../../../../lib/platform-console'
import { PlatformAccessClient } from '../_components/PlatformAccessClient'

export const dynamic = 'force-dynamic'

export default async function PlatformAccessPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const page = platformListPage(sp)
  const perPage = 500
  const [result, options] = await Promise.all([
    platformGrants({
      page,
      perPage,
      dir: 'desc',
      sort: 'updated',
    }),
    platformGrantOptions(),
  ])
  return (
    <PlatformAccessClient
      grants={result.rows}
      total={result.total}
      page={page}
      perPage={perPage}
      basePath="/platform/access"
      params={sp}
      members={options.members}
      organizations={options.organizations}
      actingUsers={options.actingUsers}
    />
  )
}

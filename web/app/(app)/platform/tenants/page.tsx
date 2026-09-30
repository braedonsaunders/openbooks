import { platformListSources } from '../../../../lib/list/platform-sources'
import { TenantsList } from './sections'

export const dynamic = 'force-dynamic'

export default async function PlatformTenantsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const source = platformListSources.tenants
  const { params, filter: environment, result } = await source.read(sp)
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
      basePath={source.basePath}
      currentParams={sp}
    />
  )
}

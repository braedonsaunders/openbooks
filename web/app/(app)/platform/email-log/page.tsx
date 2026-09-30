import { platformListSources } from '../../../../lib/list/platform-sources'
import { EmailLogList } from './sections'

export const dynamic = 'force-dynamic'

export default async function PlatformEmailLogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const source = platformListSources.emails
  const { params, filter: status, result } = await source.read(sp)
  return (
    <EmailLogList
      rows={result.rows}
      total={result.total}
      page={params.page}
      perPage={params.perPage}
      sort={params.sort}
      dir={params.dir}
      status={status}
      statusCounts={result.statusCounts}
      basePath={source.basePath}
      currentParams={sp}
    />
  )
}

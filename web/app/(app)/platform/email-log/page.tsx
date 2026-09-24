import { platformEmails } from '../../../../lib/platform-admin'
import { platformListPage } from '../../../../lib/platform-console'
import { PlatformEmailLogClient } from '../_components/PlatformEmailLogClient'

export const dynamic = 'force-dynamic'

export default async function PlatformEmailLogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const page = platformListPage(sp)
  const perPage = 200
  const result = await platformEmails({
    page,
    perPage,
    dir: 'desc',
    sort: 'created',
  })
  return <PlatformEmailLogClient rows={result.rows} total={result.total} page={page} perPage={perPage} basePath="/platform/email-log" params={sp} />
}

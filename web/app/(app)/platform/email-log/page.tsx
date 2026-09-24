import { platformEmails, type PlatformEmail } from '../../../../lib/platform-admin'
import { parseListParams, pickString } from '../../../../lib/list-params'
import { EmailLogList } from './sections'

export const dynamic = 'force-dynamic'

const BASE_PATH = '/platform/email-log'
const ALLOWED_SORTS = ['created', 'organization', 'recipient', 'subject', 'status'] as const
const STATUSES: readonly PlatformEmail['status'][] = ['queued', 'sent', 'failed', 'suppressed', 'uncertain']

export default async function PlatformEmailLogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  // The house list params: sort, direction, search, status, page and page
  // size all travel on the URL, so the loader pages in SQL and every control
  // survives refreshes and shared links. The default sort stays the
  // long-standing newest-first delivery order.
  const params = parseListParams(sp, {
    sort: 'created',
    dir: 'desc',
    perPage: 50,
    allowedSorts: ALLOWED_SORTS,
  })
  const requestedStatus = pickString(sp.status)
  const status = STATUSES.includes(requestedStatus as PlatformEmail['status'])
    ? (requestedStatus as PlatformEmail['status'])
    : undefined
  const result = await platformEmails({
    q: params.q,
    page: params.page,
    perPage: params.perPage,
    dir: params.dir,
    sort: params.sort,
    status,
  })
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
      basePath={BASE_PATH}
      currentParams={sp}
    />
  )
}

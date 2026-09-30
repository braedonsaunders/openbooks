import { ServerPagedTable } from '../../../../components/server-paged-table'
import { Badge, PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { SearchInput } from '../../../../components/search-input'
import { FilterChips } from '../../../../components/filter-bar'
import { asDate } from '../../../../lib/platform-console'
import type { PlatformEmail } from '../../../../lib/platform-admin'
import { ViewerDateTime } from '../../../../components/viewer-format'

/**
 * Composite cells in the platform email log.
 *
 * Both are a value over an optional second line, which `text` with a suffix
 * cannot express — the suffix is a sibling <div>, not an inline span.
 */

export function EmailSubjectCell({ subject, category }: { subject: string; category: string }) {
  return (
    <>
      <div className="max-w-md truncate font-medium">{subject}</div>
      {category ? <div className="text-xs text-slate-500">{category}</div> : null}
    </>
  )
}

/** Provider and send time, plus the delivery error when one was recorded. */
export function EmailEvidenceCell({ summary, error }: { summary: string; error: string }) {
  return (
    <>
      <div className="text-xs text-slate-500">{summary}</div>
      {error ? (
        <div className="mt-1 max-w-sm break-words text-xs text-red-600 dark:text-red-400">
          {error}
        </div>
      ) : null}
    </>
  )
}

const STATUS_VARIANT = {
  sent: 'success',
  queued: 'outline',
  failed: 'destructive',
  suppressed: 'warning',
  uncertain: 'warning',
} as const

const STATUSES = ['queued', 'sent', 'failed', 'suppressed', 'uncertain'] as const

/**
 * The operator email log on the house list composition (toolbar + sortable
 * table + pager), driven server-side by platformEmails.
 *
 * It replaces the AppKit delivery log, which filtered client-side over the
 * one fetched page while the statuses it offered described only that page —
 * and it never mounted inside a scroll container at all, so the log filled
 * the viewport and ran past it. The status filter now narrows in SQL with
 * loader-computed counts, and sort, search, status and page size all travel
 * on the URL. The row cells stay the shared cells above that the viewspec
 * platform widgets also render.
 */
export function EmailLogList({
  rows,
  total,
  page,
  perPage,
  sort,
  dir,
  status,
  statusCounts,
  basePath,
  currentParams,
}: {
  rows: PlatformEmail[]
  total: number
  page: number
  perPage: number
  sort: 'created' | 'organization' | 'recipient' | 'subject' | 'status'
  dir: 'asc' | 'desc'
  status: PlatformEmail['status'] | undefined
  statusCounts: Record<string, number>
  basePath: string
  currentParams: Record<string, string | string[] | undefined>
}) {
  const filtered = currentParams.q !== undefined || status !== undefined
  return (
    <ListPageLayout header={<PageHeader title="Email log" description="Delivery evidence across every organization." back={{ href: '/platform', label: 'Back to platform' }} />}>
      <div className="space-y-5">

        <ServerPagedTable
          rows={rows} rowKey={(row) => row.id}
          total={total} page={page} perPage={perPage}
          basePath={basePath} currentParams={currentParams} sort={sort} dir={dir}
          empty={filtered ? 'No deliveries match these filters.' : 'No deliveries logged yet.'}
          toolbar={<><SearchInput placeholder="Search subject, recipient, or organization…" /><FilterChips basePath={basePath} currentParams={currentParams} paramKey="status" label="Status" options={STATUSES.map((value) => ({ value, label: value[0]!.toUpperCase() + value.slice(1), count: Number(statusCounts[value] ?? 0) }))} /></>}
          columns={[
          { key: 'subject', header: 'Subject', sortKey: 'subject', cell: (row) => <EmailSubjectCell subject={row.subject} category={row.categoryKey ?? ''} /> },
          { key: 'organization', header: 'Organization', sortKey: 'organization', cell: (row) => row.orgName },
          { key: 'recipient', header: 'Recipient', sortKey: 'recipient', cell: (row) => row.recipientPrimary ?? row.recipients[0] ?? '—' },
          { key: 'status', header: 'Status', sortKey: 'status', cell: (row) => <Badge variant={STATUS_VARIANT[row.status] ?? 'secondary'}>{row.status}</Badge> },
          { key: 'delivery', header: 'Delivery', cell: (row) => <EmailEvidenceCell summary={row.provider ?? 'unknown provider'} error={row.errorMessage ?? ''} /> },
          { key: 'created', header: 'Logged', sortKey: 'created', cell: (row) => asDate(row.createdAt) ? <ViewerDateTime value={asDate(row.createdAt)!} /> : '—' },
        ]}
        />
      </div>
    </ListPageLayout>
  )
}

import { Badge, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { Pagination } from '../../../../components/pagination'
import { PerPageSelect } from '../../../../components/per-page-select'
import { SearchInput } from '../../../../components/search-input'
import { FilterChips } from '../../../../components/filter-bar'
import { SortTh } from '../../../../components/sortable-th'
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
    <ListPageLayout
      header={
        <>
          <PageHeader
            title="Email log"
            description="Delivery evidence across every organization."
            back={{ href: '/platform', label: 'Back to platform' }}
          />
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput placeholder="Search subject, recipient, or organization…" />
            <FilterChips
              basePath={basePath}
              currentParams={currentParams}
              paramKey="status"
              label="Status"
              options={STATUSES.map((value) => ({
                value,
                label: value === 'queued'
                  ? 'Queued'
                  : value === 'sent'
                    ? 'Sent'
                    : value === 'failed'
                      ? 'Failed'
                      : value === 'suppressed'
                        ? 'Suppressed'
                        : 'Uncertain',
                count: Number(statusCounts[value] ?? 0),
              }))}
            />
            <PerPageSelect basePath={basePath} currentParams={currentParams} perPage={perPage} />
          </div>
        </>
      }
    >
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <SortTh basePath={basePath} currentParams={currentParams} column="subject" sort={sort} dir={dir}>
                  Subject
                </SortTh>
                <SortTh basePath={basePath} currentParams={currentParams} column="organization" sort={sort} dir={dir}>
                  Organization
                </SortTh>
                <SortTh basePath={basePath} currentParams={currentParams} column="recipient" sort={sort} dir={dir}>
                  Recipient
                </SortTh>
                <SortTh basePath={basePath} currentParams={currentParams} column="status" sort={sort} dir={dir}>
                  Status
                </SortTh>
                <TableHead>Delivery</TableHead>
                <SortTh basePath={basePath} currentParams={currentParams} column="created" sort={sort} dir={dir}>
                  Logged
                </SortTh>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="px-3 py-8 text-center text-slate-500 dark:text-slate-400">
                    {filtered ? 'No deliveries match these filters.' : 'No deliveries logged yet.'}
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>
                      <EmailSubjectCell subject={row.subject} category={row.categoryKey ?? ''} />
                    </TableCell>
                    <TableCell className="text-slate-600 dark:text-slate-400">{row.orgName}</TableCell>
                    <TableCell className="text-slate-600 dark:text-slate-400">
                      {row.recipientPrimary ?? row.recipients[0] ?? '—'}
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[row.status] ?? 'secondary'}>{row.status}</Badge>
                    </TableCell>
                    <TableCell>
                      <EmailEvidenceCell summary={row.provider ?? 'unknown provider'} error={row.errorMessage ?? ''} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-slate-600 dark:text-slate-400">
                      <ViewerDateTime value={asDate(row.createdAt) ?? new Date()} />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
        <Pagination basePath={basePath} currentParams={currentParams} total={total} page={page} perPage={perPage} />
      </div>
    </ListPageLayout>
  )
}

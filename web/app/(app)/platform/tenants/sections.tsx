import { ServerPagedTable } from '../../../../components/server-paged-table'
import { PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { SearchInput } from '../../../../components/search-input'
import { FilterChips } from '../../../../components/filter-bar'
import type { PlatformOrganization } from '../../../../lib/platform-admin'
import {
  OrgEnvironmentCell,
  OrgLocaleCell,
  OrgNameCell,
  OrgOpenCell,
  OrgUsersCell,
} from '../organizations/sections'

const ENV_VARIANT = {
  production: 'success',
  sandbox: 'warning',
  preview: 'secondary',
} as const

/**
 * The operator organizations list on the house list composition — the same
 * shape RecordListView renders for every tenant list (toolbar + sortable
 * table + pager), driven server-side by platformOrganizations.
 *
 * It replaces the AppKit tenants table, which sorted and filtered
 * client-side over the one fetched page: everything past the first page was
 * unreachable from search AND from sort, while reading as the whole tenant list.
 * Sort, search, the environment filter and the page size all travel on the
 * URL through the house list-params helpers, so refreshes and shared links
 * hold. The row cells stay the shared organizations/sections cells the
 * viewspec platform widgets also render — one row rendering, not two.
 */
export function TenantsList({
  rows,
  total,
  page,
  perPage,
  sort,
  dir,
  environment,
  environmentCounts,
  basePath,
  currentParams,
}: {
  rows: PlatformOrganization[]
  total: number
  page: number
  perPage: number
  sort: 'name' | 'environment' | 'users' | 'sandboxes' | 'created'
  dir: 'asc' | 'desc'
  environment: 'production' | 'sandbox' | 'preview' | undefined
  environmentCounts: Record<string, number>
  basePath: string
  currentParams: Record<string, string | string[] | undefined>
}) {
  const filtered = currentParams.q !== undefined || environment !== undefined
  return (
    <ListPageLayout header={<PageHeader title="Organizations" description="Every production company, sandbox, and preview environment. Open enters that organization as the current workspace." back={{ href: '/platform', label: 'Back to platform' }} />}>
      <div className="space-y-5">

        <ServerPagedTable
          rows={rows} rowKey={(row) => row.id}
          total={total} page={page} perPage={perPage}
          basePath={basePath} currentParams={currentParams} sort={sort} dir={dir}
          empty={filtered ? 'No organizations match these filters.' : 'No organizations yet.'}
          toolbar={<><SearchInput placeholder="Search organizations…" /><FilterChips basePath={basePath} currentParams={currentParams} paramKey="environment" label="Environment" options={(['production', 'sandbox', 'preview'] as const).map((value) => ({ value, label: value[0]!.toUpperCase() + value.slice(1), count: Number(environmentCounts[value] ?? 0) }))} /></>}
          columns={[
          { key: 'name', header: 'Organization', sortKey: 'name', cell: (org) => <OrgNameCell name={org.name} subtitle={org.legalName ?? ''} /> },
          { key: 'environment', header: 'Environment', sortKey: 'environment', cell: (org) => <OrgEnvironmentCell envKind={org.envKind} variant={ENV_VARIANT[org.envKind]} parentNote={org.parentName ? `of ${org.parentName}` : ''} /> },
          { key: 'locale', header: 'Locale', cell: (org) => <OrgLocaleCell country={org.country} currency={org.baseCurrency} /> },
          { key: 'users', header: 'Users', sortKey: 'users', cell: (org) => <OrgUsersCell active={String(org.activeUserCount)} total={String(org.userCount)} /> },
          { key: 'sandboxes', header: 'Sandboxes', sortKey: 'sandboxes', align: 'right', cell: (org) => org.sandboxCount },
          { key: 'open', header: <span className="sr-only">Open</span>, className: 'w-px whitespace-nowrap px-2 text-center', style: { width: 64 }, cell: (org) => org.envKind === 'production'
            ? <OrgOpenCell orgId={org.id} />
            : <span className="text-slate-300 dark:text-slate-600" title="Only production organizations can be opened from here">—</span> },
        ]}
        />
      </div>
    </ListPageLayout>
  )
}

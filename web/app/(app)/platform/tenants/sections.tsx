import { PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { Pagination } from '../../../../components/pagination'
import { PerPageSelect } from '../../../../components/per-page-select'
import { SearchInput } from '../../../../components/search-input'
import { FilterChips } from '../../../../components/filter-bar'
import { SortTh } from '../../../../components/sortable-th'
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
 * unreachable from search AND from sort, while reading as the whole fleet.
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
    <ListPageLayout
      header={
        <>
          <PageHeader
            title="Organizations"
            description="Every production company, sandbox, and preview environment. Open enters that organization as the current workspace."
            back={{ href: '/platform', label: 'Back to platform' }}
          />
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput placeholder="Search organizations…" />
            <FilterChips
              basePath={basePath}
              currentParams={currentParams}
              paramKey="environment"
              label="Environment"
              options={(['production', 'sandbox', 'preview'] as const).map((value) => ({
                value,
                label: value === 'production' ? 'Production' : value === 'sandbox' ? 'Sandbox' : 'Preview',
                count: Number(environmentCounts[value] ?? 0),
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
                <SortTh basePath={basePath} currentParams={currentParams} column="name" sort={sort} dir={dir}>
                  Organization
                </SortTh>
                <SortTh basePath={basePath} currentParams={currentParams} column="environment" sort={sort} dir={dir}>
                  Environment
                </SortTh>
                <TableHead>Locale</TableHead>
                <SortTh basePath={basePath} currentParams={currentParams} column="users" sort={sort} dir={dir}>
                  Users
                </SortTh>
                <SortTh basePath={basePath} currentParams={currentParams} column="sandboxes" sort={sort} dir={dir}>
                  Sandboxes
                </SortTh>
                <TableHead className="w-px whitespace-nowrap px-2 text-center" style={{ width: 64 }}>
                  <span className="sr-only">Open</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="px-3 py-8 text-center text-slate-500 dark:text-slate-400">
                    {filtered ? 'No organizations match these filters.' : 'No organizations yet.'}
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((org) => (
                  <TableRow key={org.id}>
                    <TableCell>
                      <OrgNameCell name={org.name} subtitle={org.legalName ?? ''} />
                    </TableCell>
                    <TableCell>
                      <OrgEnvironmentCell
                        envKind={org.envKind}
                        variant={ENV_VARIANT[org.envKind]}
                        parentNote={org.parentName ? `of ${org.parentName}` : ''}
                      />
                    </TableCell>
                    <TableCell>
                      <OrgLocaleCell country={org.country} currency={org.baseCurrency} />
                    </TableCell>
                    <TableCell>
                      <OrgUsersCell active={String(org.activeUserCount)} total={String(org.userCount)} />
                    </TableCell>
                    <TableCell className="tabular-nums text-slate-500 dark:text-slate-400">
                      {org.sandboxCount}
                    </TableCell>
                    <TableCell className="w-px whitespace-nowrap px-2 text-center" style={{ width: 64 }}>
                      <OrgOpenCell orgId={org.id} />
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

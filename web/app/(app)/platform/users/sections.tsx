import Link from 'next/link'
import { ShieldAlert } from 'lucide-react'
import { Badge, Button, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { Pagination } from '../../../../components/pagination'
import { PerPageSelect } from '../../../../components/per-page-select'
import { SearchInput } from '../../../../components/search-input'
import { FilterChips } from '../../../../components/filter-bar'
import { SortTh } from '../../../../components/sortable-th'
import { asDate } from '../../../../lib/platform-console'
import { ViewerDateTime } from '../../../../components/viewer-format'
import type { PlatformUser } from '../../../../lib/platform-admin'

/**
 * Composite cells in the platform users list.
 *
 * The identity cell carries two independent status badges and the roles cell
 * renders a variable-length badge list — neither is a value, so both are
 * components rather than block vocabulary.
 */

export function UserIdentityCell({
  name,
  href,
  email,
  isSuperAdmin,
  isActive,
}: {
  name: string
  href: string
  email: string
  isSuperAdmin: boolean
  isActive: boolean
}) {
  return (
    <>
      <div className="flex items-center gap-2">
        <Link
          href={href as never}
          className="font-medium text-slate-900 hover:text-teal-700 dark:text-slate-100 dark:hover:text-teal-300"
        >
          {name}
        </Link>
        {isSuperAdmin ? (
          <Badge variant="warning" className="gap-1">
            <ShieldAlert size={11} /> super admin
          </Badge>
        ) : null}
        {!isActive ? <Badge variant="secondary">inactive</Badge> : null}
      </div>
      <div className="text-xs text-slate-500 dark:text-slate-400">{email}</div>
    </>
  )
}

export function UserRolesCell({ roles }: { roles: string[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {roles.map((role) => (
        <Badge key={role} variant="outline">
          {role}
        </Badge>
      ))}
    </div>
  )
}

/** Explicit grant count, or a note that the user only sees their home org. */
export function UserGrantsCell({ label, emphasised }: { label: string; emphasised: boolean }) {
  if (!emphasised) return <span className="text-slate-500">{label}</span>
  return <span className="font-medium tabular-nums">{label}</span>
}

export function UserManageCell({ href }: { href: string }) {
  return (
    <Button asChild size="sm" variant="outline">
      <Link href={href as never}>Manage</Link>
    </Button>
  )
}

/**
 * The operator users list on the house list composition (toolbar + sortable
 * table + pager), driven server-side by platformUsers.
 *
 * It replaces the AppKit users table, which filtered, sorted and counted
 * client-side over the one fetched page: search matched only the visible
 * page and the status counts described 500 rows as the fleet. The status
 * filter now narrows in SQL with loader-computed counts, and sort, search,
 * status and page size all travel on the URL. The row cells stay the shared
 * cells above that the viewspec platform widgets also render.
 */
export function UsersList({
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
  rows: PlatformUser[]
  total: number
  page: number
  perPage: number
  sort: 'name' | 'email' | 'organization' | 'role' | 'lastLogin' | 'grants'
  dir: 'asc' | 'desc'
  status: 'active' | 'inactive' | 'super' | undefined
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
            title="Users"
            description="Production login identities, organization roles, and platform privileges."
            back={{ href: '/platform', label: 'Back to platform' }}
          />
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput placeholder="Search name, email, or organization…" />
            <FilterChips
              basePath={basePath}
              currentParams={currentParams}
              paramKey="status"
              label="Status"
              options={[
                { value: 'active', label: 'Active', count: Number(statusCounts.active ?? 0) },
                { value: 'inactive', label: 'Inactive', count: Number(statusCounts.inactive ?? 0) },
                { value: 'super', label: 'Super admin', count: Number(statusCounts.super ?? 0) },
              ]}
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
                  User
                </SortTh>
                <SortTh basePath={basePath} currentParams={currentParams} column="organization" sort={sort} dir={dir}>
                  Home organization
                </SortTh>
                <SortTh basePath={basePath} currentParams={currentParams} column="role" sort={sort} dir={dir}>
                  Roles
                </SortTh>
                <SortTh basePath={basePath} currentParams={currentParams} column="grants" sort={sort} dir={dir}>
                  Grants
                </SortTh>
                <SortTh basePath={basePath} currentParams={currentParams} column="lastLogin" sort={sort} dir={dir}>
                  Last login
                </SortTh>
                <TableHead className="w-px whitespace-nowrap px-2 text-center" style={{ width: 64 }}>
                  <span className="sr-only">Manage</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="px-3 py-8 text-center text-slate-500 dark:text-slate-400">
                    {filtered ? 'No users match these filters.' : 'No users yet.'}
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell>
                      <UserIdentityCell
                        name={user.name}
                        href={`/platform/users/${user.id}`}
                        email={user.email}
                        isSuperAdmin={user.isSuperAdmin}
                        isActive={user.isActive}
                      />
                    </TableCell>
                    <TableCell className="text-slate-600 dark:text-slate-400">{user.orgName}</TableCell>
                    <TableCell>
                      <UserRolesCell roles={user.roles} />
                    </TableCell>
                    <TableCell>
                      <UserGrantsCell
                        label={user.grantCount ? `${user.grantCount} explicit` : 'Home only'}
                        emphasised={user.grantCount > 0}
                      />
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-slate-600 dark:text-slate-400">
                      {asDate(user.lastLoginAt) ? <ViewerDateTime value={asDate(user.lastLoginAt)!} /> : 'Never'}
                    </TableCell>
                    <TableCell className="w-px whitespace-nowrap px-2 text-center" style={{ width: 64 }}>
                      <UserManageCell href={`/platform/users/${user.id}`} />
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

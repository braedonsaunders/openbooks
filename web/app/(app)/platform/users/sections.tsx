import { PagedTable } from '../../../../components/paged-table'
import Link from 'next/link'
import { ShieldAlert } from 'lucide-react'
import { Badge, Button, PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { SearchInput } from '../../../../components/search-input'
import { FilterChips } from '../../../../components/filter-bar'
import { asDate } from '../../../../lib/platform-console'
import { ViewerDateTime } from '../../../../components/viewer-format'
import type { PlatformGrant, PlatformUser } from '../../../../lib/platform-admin'
import { useTranslations } from 'next-intl'
import { getTranslations } from 'next-intl/server'
import { platformUserDrawerHref } from '../../../../lib/platform-console'
import { PlatformUserDetailClient } from '../_components/PlatformUserDetailClient'

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
  labels,
}: {
  name: string
  href: string
  email: string
  isSuperAdmin: boolean
  isActive: boolean
  labels?: { superAdmin: string; inactive: string }
}) {
  const t = useTranslations('platform.users')
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
            <ShieldAlert size={11} /> {labels?.superAdmin ?? t('statuses.superAdmin')}
          </Badge>
        ) : null}
        {!isActive ? <Badge variant="secondary">{labels?.inactive ?? t('statuses.inactive')}</Badge> : null}
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

export function UserManageCell({ href, label }: { href: string; label?: string }) {
  const t = useTranslations('platform.users')
  return (
    <Button asChild size="sm" variant="outline">
      <Link href={href as never}>{label ?? t('manage')}</Link>
    </Button>
  )
}

/**
 * The operator users list on the house list composition (toolbar + sortable
 * table + pager), driven server-side by platformUsers.
 *
 * It replaces the AppKit users table, which filtered, sorted and counted
 * client-side over the one fetched page: search matched only the visible
 * page and the status counts described 500 rows as the whole list. The status
 * filter now narrows in SQL with loader-computed counts, and sort, search,
 * status and page size all travel on the URL. The row cells stay the shared
 * cells above that the viewspec platform widgets also render.
 */
export async function UsersList({
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
  detail,
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
  detail: {
    user: PlatformUser
    grants: PlatformGrant[]
    totalGrants: number
    grantsPage: number
    grantsPerPage: number
    isSelf: boolean
  } | null
}) {
  const t = await getTranslations('platform.users')
  const filtered = currentParams.q !== undefined || status !== undefined
  const closeHref = platformUserDrawerHref(basePath, currentParams)
  return (
    <ListPageLayout header={<PageHeader title={t('title')} description={t('description')} back={{ href: '/platform', label: t('backToPlatform') }} />}>
      <div className="space-y-5">

        <PagedTable
          rows={rows} rowKey={(row) => row.id}
          serverWindow={{ total, page, perPage }}
          basePath={basePath} currentParams={currentParams} sort={sort} dir={dir}
          empty={filtered ? t('emptyFiltered') : t('empty')}
          toolbarAfter={<><SearchInput placeholder={t('searchPlaceholder')} /><FilterChips basePath={basePath} currentParams={currentParams} paramKey="status" label={t('status')} options={[
            { value: 'active', label: t('statuses.active'), count: Number(statusCounts.active ?? 0) },
            { value: 'inactive', label: t('statuses.inactive'), count: Number(statusCounts.inactive ?? 0) },
            { value: 'super', label: t('statuses.superAdmin'), count: Number(statusCounts.super ?? 0) },
          ]} /></>}
          columns={[
          { key: 'user', header: t('columns.user'), sortKey: 'name', cell: (user) => <UserIdentityCell name={user.name} href={platformUserDrawerHref(basePath, currentParams, user.id)} email={user.email} isSuperAdmin={user.isSuperAdmin} isActive={user.isActive} labels={{ superAdmin: t('statuses.superAdmin'), inactive: t('statuses.inactive') }} /> },
          { key: 'organization', header: t('columns.homeOrganization'), sortKey: 'organization', cell: (user) => user.orgName },
          { key: 'roles', header: t('columns.roles'), sortKey: 'role', cell: (user) => <UserRolesCell roles={user.roles} /> },
          { key: 'grants', header: t('columns.grants'), sortKey: 'grants', cell: (user) => <UserGrantsCell label={user.grantCount ? t('explicitGrants', { count: user.grantCount }) : t('homeOnly')} emphasised={user.grantCount > 0} /> },
          { key: 'lastLogin', header: t('columns.lastLogin'), sortKey: 'lastLogin', cell: (user) => asDate(user.lastLoginAt) ? <ViewerDateTime value={asDate(user.lastLoginAt)!} /> : t('never') },
          { key: 'manage', header: <span className="sr-only">{t('manage')}</span>, className: 'w-px whitespace-nowrap px-2 text-center', style: { width: 64 }, cell: (user) => <UserManageCell href={platformUserDrawerHref(basePath, currentParams, user.id)} label={t('manage')} /> },
        ]}
        />
        {detail ? <PlatformUserDetailClient detail={detail} closeHref={closeHref} listParams={currentParams} /> : null}
      </div>
    </ListPageLayout>
  )
}

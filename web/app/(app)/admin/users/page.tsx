import Link from 'next/link'
import { sql, type SQL } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/db.ts'
import { Badge, Button, EmptyState, PageHeader } from '@openbooks/ui'
import { Users } from 'lucide-react'
import { ListPageLayout } from '../../../../components/page-layout'
import { SearchInput } from '../../../../components/search-input'
import { FilterChips } from '../../../../components/filter-bar'
import { SortTh } from '../../../../components/sortable-th'
import { Pagination } from '../../../../components/pagination'
import { requirePermission } from '../../../../lib/authz'
import { dateTime } from '../../../../lib/format'
import { parseListParams, pickString } from '../../../../lib/list-params'
import { RoleAssignmentButton, ActiveToggle } from './UserActions'

export async function generateMetadata() {
  const t = await getTranslations('admin.users')
  return { title: t('metaTitle') }
}
export const dynamic = 'force-dynamic'

const BASE = '/admin/users'
const SORTS = ['name', 'email', 'last_login'] as const
const ORDER: Record<(typeof SORTS)[number], string> = {
  name: 'lower(u.name)',
  email: 'lower(u.email)',
  last_login: 'u.last_login_at',
}

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('admin.users.manage')
  const t = await getTranslations('admin.users')
  const tCommon = await getTranslations('common')
  const tHub = await getTranslations('admin.hub')
  const orgId = authz.user.orgId
  const sp = await searchParams
  const listParams = parseListParams(sp, {
    sort: 'name',
    dir: 'asc',
    perPage: 25,
    allowedSorts: SORTS,
  })
  const statusParam = pickString(sp.status)
  const status = statusParam === 'inactive' || statusParam === 'all' ? statusParam : 'active'

  const filters: SQL[] = [sql`u.org_id = ${orgId}`]
  if (listParams.q) {
    const like = `%${listParams.q}%`
    filters.push(sql`(u.name ilike ${like} or u.email ilike ${like})`)
  }
  const searchWhere = sql.join(filters, sql` and `)
  if (status !== 'all') filters.push(sql`u.is_active = ${status === 'active'}`)
  const where = sql.join(filters, sql` and `)
  // Sort key is whitelisted through ORDER — never raw user input.
  const orderBy = sql.raw(
    `${ORDER[listParams.sort]} ${listParams.dir === 'asc' ? 'asc nulls last' : 'desc nulls last'}, lower(u.email) asc`,
  )

  const [rowsR, countR, statusCountsR, rolesR] = (await Promise.all([
    db.execute(sql`
      select u.id, u.name, u.email, u.is_active, u.last_login_at
        from users u
       where ${where}
       order by ${orderBy}
       limit ${listParams.perPage} offset ${(listParams.page - 1) * listParams.perPage}`),
    db.execute(sql`select count(*)::int as c from users u where ${where}`),
    db.execute(sql`
      select u.is_active, count(*)::int as c from users u
       where ${searchWhere} group by u.is_active`),
    db.execute(sql`
      select id, key, name, is_built_in from app_roles
       where org_id = ${orgId}
       order by is_built_in desc, name asc`),
  ])) as any[]

  const users = rowsR.rows as {
    id: string
    name: string
    email: string
    is_active: boolean
    last_login_at: string | null
  }[]
  const total = Number(countR.rows[0]?.c ?? 0)
  const statusCounts = Object.fromEntries(
    statusCountsR.rows.map((r: any) => [r.is_active ? 'active' : 'inactive', Number(r.c)]),
  ) as Record<string, number>
  const allRoles = rolesR.rows as { id: string; key: string; name: string; is_built_in: boolean }[]

  const userIds = users.map((u) => u.id)
  const assignmentsR =
    userIds.length === 0
      ? { rows: [] }
      : ((await db.execute(sql`
          select a.user_id, r.id as role_id, r.name as role_name
            from role_assignments a
            join app_roles r on r.id = a.role_id
           where a.org_id = ${orgId} and a.user_id = any(${`{${userIds.join(',')}}`}::uuid[])
           order by r.name asc`)) as any)
  const assignments = assignmentsR.rows as { user_id: string; role_id: string; role_name: string }[]
  const rolesByUser = new Map<string, { id: string; name: string }[]>()
  for (const a of assignments) {
    const list = rolesByUser.get(a.user_id) ?? []
    list.push({ id: a.role_id, name: a.role_name })
    rolesByUser.set(a.user_id, list)
  }

  const sortProps = { basePath: BASE, currentParams: sp, sort: listParams.sort, dir: listParams.dir }

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            back={{ href: '/admin', label: tHub('title') }}
            title={t('title')}
            description={t('description')}
            actions={
              <Link href="/admin/roles">
                <Button variant="outline">{t('manageRoles')}</Button>
              </Link>
            }
          />
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <SearchInput placeholder={t('searchPlaceholder')} />
            <FilterChips
              basePath={BASE}
              currentParams={sp}
              paramKey="status"
              label={t('statusFilter')}
              defaultValue="active"
              options={[
                { value: 'active', label: tCommon('labels.active'), count: statusCounts.active ?? 0 },
                { value: 'inactive', label: tCommon('labels.inactive'), count: statusCounts.inactive ?? 0 },
              ]}
            />
          </div>
        </>
      }
    >
      {users.length === 0 ? (
        <EmptyState
          icon={<Users />}
          title={t('emptyTitle')}
          description={listParams.q ? t('emptySearchDescription') : t('emptyFilterDescription')}
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/60 text-left text-xs tracking-wide text-slate-500 uppercase dark:border-slate-800 dark:bg-slate-900/80 dark:text-slate-400">
                <SortTh column="name" {...sortProps}>
                  {tCommon('labels.name')}
                </SortTh>
                <SortTh column="email" {...sortProps}>
                  {tCommon('labels.email')}
                </SortTh>
                <th className="px-3 py-2">{t('table.roles')}</th>
                <th className="px-3 py-2">{tCommon('labels.status')}</th>
                <SortTh column="last_login" {...sortProps}>
                  {t('table.lastSignIn')}
                </SortTh>
                <th className="px-3 py-2 text-right">{tCommon('labels.actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {users.map((u) => {
                const assigned = rolesByUser.get(u.id) ?? []
                const isSelf = u.id === authz.user.id
                return (
                  <tr key={u.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/60">
                    <td className="px-3 py-2 font-medium text-slate-900 dark:text-slate-100">
                      {u.name}
                      {isSelf ? (
                        <Badge variant="secondary" className="ml-2 text-[10px]">
                          {t('you')}
                        </Badge>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-slate-600 dark:text-slate-400">{u.email}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap items-center gap-1">
                        {assigned.length === 0 ? (
                          <Badge variant="warning" className="text-[10px]">
                            {t('unassignedRole')}
                          </Badge>
                        ) : (
                          assigned.map((r) => (
                            <Badge key={r.id} variant="outline">
                              {r.name}
                            </Badge>
                          ))
                        )}
                        <RoleAssignmentButton
                          userId={u.id}
                          userName={u.name}
                          allRoles={allRoles.map((r) => ({
                            id: r.id,
                            name: r.name,
                            isBuiltIn: r.is_built_in,
                          }))}
                          assignedRoleIds={assigned.map((r) => r.id)}
                        />
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant={u.is_active ? 'success' : 'destructive'}>
                        {u.is_active ? t('statusActive') : t('statusInactive')}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-slate-600 dark:text-slate-400">
                      {u.last_login_at ? dateTime(u.last_login_at) : '—'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <ActiveToggle userId={u.id} userName={u.name} isActive={u.is_active} isSelf={isSelf} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <Pagination
        basePath={BASE}
        currentParams={sp}
        total={total}
        page={listParams.page}
        perPage={listParams.perPage}
      />
    </ListPageLayout>
  )
}

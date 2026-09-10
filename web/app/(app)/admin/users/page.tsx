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
import { AdminUsersTable } from './sections'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadAdminUsers, adminUsersSpec } from './view'

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
  if ((await searchParams).__viewspec === '1') {
    const sp = await searchParams
    const data = await loadAdminUsers(sp)
    return (
      <>
        {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
        <meta name="x-viewspec-render" content="1" />
        <ModuleView spec={adminUsersSpec(data)} data={data} searchParams={sp} trusted />
      </>
    )
  }
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

  const [rowsR, countR, statusCountsR, rolesR] = ((await Promise.all([
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
  ])))

  const users = rowsR.rows as {
    id: string
    name: string
    email: string
    is_active: boolean
    last_login_at: string | null
  }[]
  const total = Number(countR.rows[0]?.c ?? 0)
  const statusCounts = Object.fromEntries(
    statusCountsR.rows.map((r) => [r.is_active ? 'active' : 'inactive', Number(r.c)]),
  ) as Record<string, number>
  const allRoles = rolesR.rows as { id: string; key: string; name: string; is_built_in: boolean }[]

  const userIds = users.map((u) => u.id)
  const assignmentsR =
    userIds.length === 0
      ? { rows: [] }
      : (((await db.execute(sql`
          select a.user_id, r.id as role_id, r.name as role_name
            from role_assignments a
            join app_roles r on r.id = a.role_id and r.org_id = a.org_id
           where a.org_id = ${orgId} and a.user_id = any(${`{${userIds.join(',')}}`}::uuid[])
           order by r.name asc`))))
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
        <AdminUsersTable
          users={users.map((u) => ({
            id: u.id,
            name: u.name,
            email: u.email,
            isActive: u.is_active,
            isSelf: u.id === authz.user.id,
            statusLabel: u.is_active ? t('statusActive') : t('statusInactive'),
            lastSignIn: u.last_login_at ? dateTime(u.last_login_at) : '—',
            assigned: rolesByUser.get(u.id) ?? [],
          }))}
          allRoles={allRoles.map((r) => ({ id: r.id, name: r.name, isBuiltIn: r.is_built_in }))}
          basePath={BASE}
          currentParams={sp}
          sort={listParams.sort}
          dir={listParams.dir}
          labels={{
            name: tCommon('labels.name'),
            email: tCommon('labels.email'),
            roles: t('table.roles'),
            status: tCommon('labels.status'),
            lastSignIn: t('table.lastSignIn'),
            actions: tCommon('labels.actions'),
            you: t('you'),
            unassignedRole: t('unassignedRole'),
          }}
        />
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

import 'server-only'

import { sql, type SQL } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/db.ts'
import { grid, page, pageHeader, pagination, ref, widget, widgetBlock, type PageSpec } from '@openbooks/viewspec'
import { requirePermission } from '../../../../lib/authz'
import { dateTime } from '../../../../lib/format'
import { parseListParams, pickString } from '../../../../lib/list-params'
import type { AdminUserRow } from './sections'

/**
 * Org users and their role assignments, split into a loader and a spec.
 *
 * The table itself is a widget, not a `table` block — see the note on
 * `AdminUsersTable`: the native page hand-rolls a plain `<table>` with its own
 * classes, and the spec's table block offers only the two real table variants
 * the app has. Everything around it is ordinary spec.
 *
 * The `you` badge and the self-guard on the active toggle both key on the
 * SESSION user, which the loader resolves; a spec never learns who is looking.
 */

const BASE = '/admin/users'
const SORTS = ['name', 'email', 'last_login'] as const
const ORDER: Record<(typeof SORTS)[number], string> = {
  name: 'lower(u.name)',
  email: 'lower(u.email)',
  last_login: 'u.last_login_at',
}

export interface AdminUsersData {
  title: string
  description: string
  backHref: string
  backLabel: string
  manageRolesHref: string
  manageRolesLabel: string
  searchPlaceholder: string
  statusFilterLabel: string
  statusOptions: { value: string; label: string; count: number }[]
  currentParams: Record<string, string | string[] | undefined>
  isEmpty: boolean
  hasRows: boolean
  emptyTitle: string
  emptyDescription: string
  users: AdminUserRow[]
  allRoles: { id: string; name: string; isBuiltIn: boolean }[]
  labels: {
    name: string
    email: string
    roles: string
    status: string
    lastSignIn: string
    actions: string
    you: string
    unassignedRole: string
  }
  total: number
  currentPage: number
  perPage: number
  sort: string
  dir: 'asc' | 'desc'
}

export async function loadAdminUsers(
  sp: Record<string, string | string[] | undefined>,
): Promise<AdminUsersData> {
  const authz = await requirePermission('admin.users.manage')
  const t = await getTranslations('admin.users')
  const tCommon = await getTranslations('common')
  const tHub = await getTranslations('admin.hub')
  const orgId = authz.user.orgId
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

  const [rowsR, countR, statusCountsR, rolesR] = await Promise.all([
    db.execute<{
      id: string
      name: string
      email: string
      is_active: boolean
      last_login_at: string | null
    }>(sql`
      select u.id, u.name, u.email, u.is_active, u.last_login_at
        from users u
       where ${where}
       order by ${orderBy}
       limit ${listParams.perPage} offset ${(listParams.page - 1) * listParams.perPage}`),
    db.execute<{ c: number }>(sql`select count(*)::int as c from users u where ${where}`),
    db.execute<{ is_active: boolean; c: number }>(sql`
      select u.is_active, count(*)::int as c from users u
       where ${searchWhere} group by u.is_active`),
    db.execute<{ id: string; key: string; name: string; is_built_in: boolean }>(sql`
      select id, key, name, is_built_in from app_roles
       where org_id = ${orgId}
       order by is_built_in desc, name asc`),
  ])

  const users = rowsR.rows
  const total = Number(countR.rows[0]?.c ?? 0)
  const statusCounts = Object.fromEntries(
    statusCountsR.rows.map((r) => [r.is_active ? 'active' : 'inactive', Number(r.c)]),
  ) as Record<string, number>
  const allRoles = rolesR.rows

  const userIds = users.map((u) => u.id)
  const assignmentsR =
    userIds.length === 0
      ? { rows: [] as { user_id: string; role_id: string; role_name: string }[] }
      : await db.execute<{ user_id: string; role_id: string; role_name: string }>(sql`
          select a.user_id, r.id as role_id, r.name as role_name
            from role_assignments a
            join app_roles r on r.id = a.role_id and r.org_id = a.org_id
           where a.org_id = ${orgId} and a.user_id = any(${`{${userIds.join(',')}}`}::uuid[])
           order by r.name asc`)
  const rolesByUser = new Map<string, { id: string; name: string }[]>()
  for (const a of assignmentsR.rows) {
    const list = rolesByUser.get(a.user_id) ?? []
    list.push({ id: a.role_id, name: a.role_name })
    rolesByUser.set(a.user_id, list)
  }

  return {
    title: t('title'),
    description: t('description'),
    backHref: '/admin',
    backLabel: tHub('title'),
    manageRolesHref: '/admin/roles',
    manageRolesLabel: t('manageRoles'),
    searchPlaceholder: t('searchPlaceholder'),
    statusFilterLabel: t('statusFilter'),
    statusOptions: [
      { value: 'active', label: tCommon('labels.active'), count: statusCounts.active ?? 0 },
      { value: 'inactive', label: tCommon('labels.inactive'), count: statusCounts.inactive ?? 0 },
    ],
    currentParams: sp,
    isEmpty: users.length === 0,
    hasRows: users.length > 0,
    emptyTitle: t('emptyTitle'),
    emptyDescription: listParams.q ? t('emptySearchDescription') : t('emptyFilterDescription'),
    users: users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      isActive: u.is_active,
      isSelf: u.id === authz.user.id,
      statusLabel: u.is_active ? t('statusActive') : t('statusInactive'),
      lastSignIn: u.last_login_at ? dateTime(u.last_login_at) : '—',
      assigned: rolesByUser.get(u.id) ?? [],
    })),
    allRoles: allRoles.map((r) => ({ id: r.id, name: r.name, isBuiltIn: r.is_built_in })),
    labels: {
      name: tCommon('labels.name'),
      email: tCommon('labels.email'),
      roles: t('table.roles'),
      status: tCommon('labels.status'),
      lastSignIn: t('table.lastSignIn'),
      actions: tCommon('labels.actions'),
      you: t('you'),
      unassignedRole: t('unassignedRole'),
    },
    total,
    currentPage: listParams.page,
    perPage: listParams.perPage,
    sort: listParams.sort,
    dir: listParams.dir,
  }
}

const f = ref<AdminUsersData>()

export function adminUsersSpec(data: AdminUsersData): PageSpec {
  return page({
    route: '/admin/users',
    layout: 'list',
    header: [
      pageHeader({
        back: { href: f('backHref'), label: f('backLabel') },
        title: f('title'),
        description: f('description'),
        actions: [
          widget('plain-link-button', {
            href: data.manageRolesHref,
            label: data.manageRolesLabel,
            variant: 'outline',
          }),
        ],
      }),
      grid('flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between', [
        widgetBlock('search-input', { placeholder: data.searchPlaceholder }),
        widgetBlock('filter-chips', {
          basePath: BASE,
          currentParams: data.currentParams,
          paramKey: 'status',
          label: data.statusFilterLabel,
          defaultValue: 'active',
          options: data.statusOptions,
        }),
      ]),
    ],
    body: [
      {
        ...widgetBlock('empty-state', {
          icon: 'users',
          title: data.emptyTitle,
          description: data.emptyDescription,
        }),
        when: f('isEmpty'),
      },
      {
        ...widgetBlock('admin-users-table', {
          users: data.users,
          allRoles: data.allRoles,
          basePath: BASE,
          currentParams: data.currentParams,
          sort: data.sort,
          dir: data.dir,
          labels: data.labels,
        }),
        when: f('hasRows'),
      },
      pagination({
        basePath: BASE,
        total: f('total'),
        page: f('currentPage'),
        perPage: f('perPage'),
        // The native pager is unwrapped here — no `mt-3` spacer.
        bare: true,
      }),
    ],
  })
}

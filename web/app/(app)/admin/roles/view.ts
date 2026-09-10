import 'server-only'

import { sql, type SQL } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/db.ts'
import { grid, page, pageHeader, pagination, ref, widget, widgetBlock, type PageSpec } from '@openbooks/viewspec'
import { requirePermission } from '../../../../lib/authz'
import { parseListParams, pickString } from '../../../../lib/list-params'
import { isMultiSubsidiary, subsidiaryOptions } from '../../../../lib/subsidiaries'
import type { RoleRow, SubsidiaryPickerOption } from './RoleEditor'

/**
 * Org roles with permission counts and member counts, split into a loader
 * and a spec.
 *
 * The table itself is a widget, not a `table` block — see the note on
 * `AdminRolesTable`: the native page hand-rolls a plain `<table>` with its
 * own classes (font-mono key column, line-clamped description, tabular-nums
 * counts, type badges, per-row editor buttons), and the spec's table block
 * offers only the two real table variants the app has. Everything around
 * it — header, search, type chips, empty state, pager — is ordinary spec.
 *
 * The SubsidiaryPickerOption list is loader data (plain rows), but whether
 * the subsidiary UI renders at all keys on the SESSION org's
 * multi-subsidiary state, which the loader resolves; a spec never learns
 * which org is looking.
 */

const BASE = '/admin/roles'
const SORTS = ['name', 'permissions', 'members'] as const
const ORDER: Record<(typeof SORTS)[number], string> = {
  name: 'lower(r.name)',
  permissions: 'permission_count',
  members: 'member_count',
}

export interface AdminRoleRow extends RoleRow {
  permissionCount: number
  memberCount: number
}

export interface AdminRolesData {
  title: string
  description: string
  backHref: string
  backLabel: string
  manageUsersHref: string
  manageUsersLabel: string
  searchPlaceholder: string
  typeFilterLabel: string
  typeOptions: { value: string; label: string; count: number }[]
  currentParams: Record<string, string | string[] | undefined>
  isEmpty: boolean
  hasRows: boolean
  emptyTitle: string
  emptyDescription: string
  roles: AdminRoleRow[]
  subsidiaries: SubsidiaryPickerOption[] | null
  labels: {
    name: string
    key: string
    description: string
    permissions: string
    members: string
    type: string
    actions: string
    builtIn: string
    custom: string
    noDescription: string
  }
  total: number
  currentPage: number
  perPage: number
  sort: string
  dir: 'asc' | 'desc'
}

export async function loadAdminRoles(
  sp: Record<string, string | string[] | undefined>,
): Promise<AdminRolesData> {
  const authz = await requirePermission('admin.roles.manage')
  const t = await getTranslations('admin.roles')
  const tCommon = await getTranslations('common')
  const tHub = await getTranslations('admin.hub')
  const orgId = authz.user.orgId
  const listParams = parseListParams(sp, {
    sort: 'name',
    dir: 'asc',
    perPage: 25,
    allowedSorts: SORTS,
  })
  const typeParam = pickString(sp.type)
  const type = typeParam === 'built_in' || typeParam === 'custom' ? typeParam : undefined

  const filters: SQL[] = [sql`r.org_id = ${orgId}`]
  if (listParams.q) {
    const like = `%${listParams.q}%`
    filters.push(sql`(r.name ilike ${like} or r.description ilike ${like} or r.key ilike ${like})`)
  }
  const searchWhere = sql.join(filters, sql` and `)
  if (type) filters.push(sql`r.is_built_in = ${type === 'built_in'}`)
  const where = sql.join(filters, sql` and `)
  // Sort key is whitelisted through ORDER — never raw user input.
  const orderBy = sql.raw(
    `${ORDER[listParams.sort]} ${listParams.dir === 'asc' ? 'asc' : 'desc'}, lower(r.name) asc`,
  )

  // Subsidiary access is only surfaced in multi-subsidiary orgs — single-sub
  // orgs never see any subsidiary UI.
  const subsidiaries: SubsidiaryPickerOption[] | null = (await isMultiSubsidiary(authz.user.orgId))
    ? (await subsidiaryOptions()).map((s) => ({ id: s.id, name: s.name, depth: s.depth }))
    : null

  const [rowsR, countR, typeCountsR] = ((await Promise.all([
    db.execute(sql`
      select r.id, r.key, r.name, r.description, r.is_built_in, r.permissions,
             r.subsidiary_restriction,
             coalesce(jsonb_array_length(r.permissions), 0)::int as permission_count,
             (select count(*)::int from role_assignments a
               where a.role_id = r.id and a.org_id = r.org_id) as member_count
        from app_roles r
       where ${where}
       order by ${orderBy}
       limit ${listParams.perPage} offset ${(listParams.page - 1) * listParams.perPage}`),
    db.execute(sql`select count(*)::int as c from app_roles r where ${where}`),
    db.execute(sql`
      select r.is_built_in, count(*)::int as c from app_roles r
       where ${searchWhere} group by r.is_built_in`),
  ])))

  const roles = (rowsR.rows as any[]).map(
    (r): AdminRoleRow => ({
      id: r.id,
      key: r.key,
      name: r.name,
      description: r.description,
      isBuiltIn: r.is_built_in,
      permissions: Array.isArray(r.permissions) ? r.permissions : [],
      subsidiaryRestriction: r.subsidiary_restriction ?? { mode: 'all' },
      permissionCount: Number(r.permission_count),
      memberCount: Number(r.member_count),
    }),
  )
  const total = Number(countR.rows[0]?.c ?? 0)
  const typeCounts = Object.fromEntries(
    typeCountsR.rows.map((r) => [r.is_built_in ? 'built_in' : 'custom', Number(r.c)]),
  ) as Record<string, number>

  return {
    title: t('title'),
    description: t('description'),
    backHref: '/admin',
    backLabel: tHub('title'),
    manageUsersHref: '/admin/users',
    manageUsersLabel: t('manageUsers'),
    searchPlaceholder: t('searchPlaceholder'),
    typeFilterLabel: t('typeFilter'),
    typeOptions: [
      { value: 'built_in', label: t('builtIn'), count: typeCounts.built_in ?? 0 },
      { value: 'custom', label: t('custom'), count: typeCounts.custom ?? 0 },
    ],
    currentParams: sp,
    isEmpty: roles.length === 0,
    hasRows: roles.length > 0,
    emptyTitle: !listParams.q && !type ? t('emptyTitle') : t('noMatchTitle'),
    emptyDescription: !listParams.q && !type ? t('emptyDescription') : t('noMatchDescription'),
    roles,
    subsidiaries,
    labels: {
      name: tCommon('labels.name'),
      key: t('table.key'),
      description: tCommon('labels.description'),
      permissions: t('table.permissions'),
      members: t('table.members'),
      type: tCommon('labels.type'),
      actions: tCommon('labels.actions'),
      builtIn: t('builtIn'),
      custom: t('custom'),
      noDescription: '—',
    },
    total,
    currentPage: listParams.page,
    perPage: listParams.perPage,
    sort: listParams.sort,
    dir: listParams.dir,
  }
}

const f = ref<AdminRolesData>()

export function adminRolesSpec(data: AdminRolesData): PageSpec {
  return page({
    layout: 'list',
    header: [
      pageHeader({
        back: { href: f('backHref'), label: f('backLabel') },
        title: f('title'),
        description: f('description'),
        actionsClassName: 'flex items-center gap-2',
        actions: [
          widget('plain-link-button', {
            href: data.manageUsersHref,
            label: data.manageUsersLabel,
            variant: 'outline',
          }),
          widget('new-role', { subsidiaries: data.subsidiaries }),
        ],
      }),
      grid('flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between', [
        widgetBlock('search-input', { placeholder: data.searchPlaceholder }),
        widgetBlock('filter-chips', {
          basePath: BASE,
          currentParams: data.currentParams,
          paramKey: 'type',
          label: data.typeFilterLabel,
          options: data.typeOptions,
        }),
      ]),
    ],
    body: [
      {
        ...widgetBlock('empty-state', {
          icon: 'shield-check',
          title: data.emptyTitle,
          description: data.emptyDescription,
        }),
        when: f('isEmpty'),
      },
      {
        ...widgetBlock('admin-roles-table', {
          roles: data.roles,
          subsidiaries: data.subsidiaries,
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

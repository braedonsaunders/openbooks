import 'server-only'

import {
  column,
  field,
  grid,
  page,
  pageHeader,
  pagination,
  ref,
  table,
  text,
  widgetBlock,
  widgetCell,
  type PageSpec,
} from '@openbooks/viewspec'
import { parseListParams, pickString } from '../../../../lib/list-params'
import { platformUsers } from '../../../../lib/platform-admin'

/**
 * Platform users, split into a loader and a spec. No new vocabulary.
 *
 * Every conditional on this page collapses in the loader: the two status
 * badges become booleans, and the grants cell's "N explicit" versus "Home only"
 * becomes a label plus an emphasis flag rather than a comparison the spec
 * performs.
 */

const BASE = '/platform/users'
const SORTS = ['name', 'email', 'organization', 'role', 'lastLogin', 'grants'] as const

function formatDate(value: string | Date | null): string {
  if (!value) return 'Never'
  return new Intl.DateTimeFormat('en-CA', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  )
}

export interface PlatformUserRow {
  id: string
  name: string
  href: string
  email: string
  isSuperAdmin: boolean
  isActive: boolean
  orgName: string
  roles: string[]
  grantsLabel: string
  grantsEmphasised: boolean
  lastLogin: string
}

export interface PlatformUsersData {
  currentParams: Record<string, string | string[] | undefined>
  statusOptions: { value: string; label: string; count: number }[]
  isEmpty: boolean
  hasRows: boolean
  rows: PlatformUserRow[]
  total: number
  currentPage: number
  perPage: number
  sort: string
  dir: string
}

export async function loadPlatformUsers(
  sp: Record<string, string | string[] | undefined>,
): Promise<PlatformUsersData> {
  const statusParam = pickString(sp.status)
  const status =
    statusParam === 'active' || statusParam === 'inactive' || statusParam === 'super'
      ? statusParam
      : undefined
  const params = parseListParams(sp, {
    sort: 'name',
    dir: 'asc',
    perPage: 25,
    allowedSorts: SORTS,
  })
  const result = await platformUsers({ ...params, status })

  return {
    currentParams: sp,
    statusOptions: [
      { value: 'active', label: 'Active', count: result.statusCounts.active ?? 0 },
      { value: 'inactive', label: 'Inactive', count: result.statusCounts.inactive ?? 0 },
      { value: 'super', label: 'Super admin', count: result.statusCounts.super ?? 0 },
    ],
    isEmpty: result.rows.length === 0,
    hasRows: result.rows.length > 0,
    rows: result.rows.map((user) => ({
      id: user.id,
      name: user.name,
      href: `/platform/users/${user.id}`,
      email: user.email,
      isSuperAdmin: user.isSuperAdmin,
      isActive: user.isActive,
      orgName: user.orgName,
      roles: user.roles,
      grantsLabel: user.grantCount > 0 ? `${user.grantCount} explicit` : 'Home only',
      grantsEmphasised: user.grantCount > 0,
      lastLogin: formatDate(user.lastLoginAt),
    })),
    total: result.total,
    currentPage: params.page,
    perPage: params.perPage,
    sort: params.sort,
    dir: params.dir,
  }
}

const f = ref<PlatformUsersData>()
const item = field

export function platformUsersSpec(data: PlatformUsersData): PageSpec {
  return page({
    layout: 'list',
    header: [
      pageHeader({
        title: 'Users',
        description: 'Production login identities, organization roles, and platform privileges.',
        back: { href: '/platform', label: 'Super Admin' },
      }),
      grid('flex flex-wrap items-center gap-2', [
        widgetBlock('search-input', {
          placeholder: 'Search user, email, organization, or role…',
        }),
        widgetBlock('filter-chips', {
          basePath: BASE,
          currentParams: data.currentParams,
          paramKey: 'status',
          label: 'Status',
          options: data.statusOptions,
        }),
      ]),
    ],
    body: [
      {
        ...widgetBlock('empty-state', {
          icon: 'users',
          title: 'No users found',
          description: 'Try broadening the search or status filter.',
        }),
        when: f('isEmpty'),
      },
      {
        ...grid('overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900', [
          table({
            variant: 'app',
            rows: f('rows'),
            rowKey: item('id'),
            sorting: { basePath: BASE, sort: f('sort'), dir: f('dir') },
            columns: [
              column(
                'User',
                widgetCell('user-identity-cell', {
                  name: item('name'),
                  href: item('href'),
                  email: item('email'),
                  isSuperAdmin: item('isSuperAdmin'),
                  isActive: item('isActive'),
                }),
                { sort: 'name' },
              ),
              column('Home organization', text(item('orgName')), { sort: 'organization' }),
              column('Role', widgetCell('user-roles-cell', { roles: item('roles') }), { sort: 'role' }),
              column(
                'Access',
                widgetCell('user-grants-cell', {
                  label: item('grantsLabel'),
                  emphasised: item('grantsEmphasised'),
                }),
                { sort: 'grants' },
              ),
              column('Last login', text(item('lastLogin')), {
                sort: 'lastLogin',
                className: 'text-sm text-slate-600 dark:text-slate-300',
              }),
              column('Details', widgetCell('user-manage-cell', { href: item('href') }), { align: 'right' }),
            ],
          }),
          pagination({
            basePath: BASE,
            total: f('total'),
            page: f('currentPage'),
            perPage: f('perPage'),
            bare: true,
          }),
        ]),
        when: f('hasRows'),
      },
    ],
  })
}

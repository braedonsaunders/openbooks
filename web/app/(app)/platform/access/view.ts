import 'server-only'

import {
  badge,
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
import { platformGrantOptions, platformGrants } from '../../../../lib/platform-admin'

/**
 * Cross-organization access grants, split into a loader and a spec.
 *
 * Uses the `sortable-th` header variant: this list wraps the shared TableHead
 * rather than emitting a plain `<th>`, and the two are not interchangeable.
 *
 * The control column binds a SERVER ACTION to a grant id. A bound function
 * cannot travel through a spec — it is not serializable, and it is authority
 * rather than presentation — so the spec passes the id and the binding happens
 * inside the cell component.
 */

const BASE = '/platform/access'
const SORTS = ['member', 'organization', 'actingUser', 'updated'] as const

function formatDate(value: string | Date): string {
  return new Intl.DateTimeFormat('en-CA', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  )
}

export interface GrantRow {
  id: string
  memberName: string
  memberDetail: string
  orgName: string
  actingName: string
  actingEmail: string
  statusLabel: string
  statusVariant: 'success' | 'secondary'
  updated: string
  isActive: boolean
}

export interface PlatformAccessData {
  grantOptions: Record<string, unknown>
  currentParams: Record<string, string | string[] | undefined>
  statusOptions: { value: string; label: string; count: number }[]
  isEmpty: boolean
  hasRows: boolean
  rows: GrantRow[]
  total: number
  currentPage: number
  perPage: number
  sort: string
  dir: string
}

export async function loadPlatformAccess(
  sp: Record<string, string | string[] | undefined>,
): Promise<PlatformAccessData> {
  const statusParam = pickString(sp.status)
  const status = statusParam === 'active' || statusParam === 'inactive' ? statusParam : undefined
  const params = parseListParams(sp, {
    sort: 'updated',
    dir: 'desc',
    perPage: 25,
    allowedSorts: SORTS,
  })
  const [result, options] = await Promise.all([
    platformGrants({ ...params, status }),
    platformGrantOptions(),
  ])

  return {
    grantOptions: options as unknown as Record<string, unknown>,
    currentParams: sp,
    statusOptions: [
      { value: 'active', label: 'Active', count: result.statusCounts.active ?? 0 },
      { value: 'inactive', label: 'Revoked', count: result.statusCounts.inactive ?? 0 },
    ],
    isEmpty: result.rows.length === 0,
    hasRows: result.rows.length > 0,
    rows: result.rows.map((grant) => ({
      id: grant.id,
      memberName: grant.memberName,
      memberDetail: `${grant.memberEmail} · ${grant.memberOrgName}`,
      orgName: grant.orgName,
      actingName: grant.actingName,
      actingEmail: grant.actingEmail,
      statusLabel: grant.isActive ? 'active' : 'revoked',
      statusVariant: grant.isActive ? 'success' : 'secondary',
      updated: formatDate(grant.updatedAt),
      isActive: grant.isActive,
    })),
    total: result.total,
    currentPage: params.page,
    perPage: params.perPage,
    sort: params.sort,
    dir: params.dir,
  }
}

const f = ref<PlatformAccessData>()
const item = field

export function platformAccessSpec(data: PlatformAccessData): PageSpec {
  return page({
    layout: 'list',
    bodyClassName: 'space-y-5',
    header: [
      pageHeader({
        title: 'Cross-org access',
        description: 'Explicit, auditable access mappings between production organizations.',
        back: { href: '/platform', label: 'Super Admin' },
      }),
      grid('flex flex-wrap items-center gap-2', [
        widgetBlock('search-input', {
          placeholder: 'Search member, organization, or acting user…',
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
      widgetBlock('grant-access-form', { options: data.grantOptions }),
      {
        ...widgetBlock('empty-state', {
          icon: 'key-round',
          title: 'No access grants found',
          description: 'Create an explicit mapping above, or broaden the search and status filter.',
        }),
        when: f('isEmpty'),
      },
      {
        ...grid('overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900', [
          table({
            variant: 'app',
            rows: f('rows'),
            rowKey: item('id'),
            sorting: { basePath: BASE, sort: f('sort'), dir: f('dir'), header: 'sortable-th' },
            columns: [
              column(
                'Member identity',
                widgetCell('identity-cell', { name: item('memberName'), detail: item('memberDetail') }),
                { sort: 'member' },
              ),
              column('Target organization', text(item('orgName')), {
                sort: 'organization',
                className: 'font-medium',
              }),
              column(
                'Acts as',
                widgetCell('acting-cell', { name: item('actingName'), email: item('actingEmail') }),
                { sort: 'actingUser' },
              ),
              column('Status', badge(item('statusLabel'), { variant: item('statusVariant') })),
              column('Last changed', text(item('updated')), {
                sort: 'updated',
                className: 'text-sm text-slate-600 dark:text-slate-300',
              }),
              column(
                'Control',
                widgetCell('access-control-cell', { grantId: item('id'), isActive: item('isActive') }),
                { align: 'right' },
              ),
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

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
import { platformOrganizations } from '../../../../lib/platform-admin'

/**
 * Organizations, split into a loader and a spec.
 *
 * Four of its six cells are small composites (name over id, badge over parent
 * note, country over currency, active-over-total users) and the last posts a
 * server action. All five are components; the spec composes the table around
 * them. No new vocabulary.
 */

const BASE = '/platform/organizations'
const SORTS = ['name', 'environment', 'users', 'sandboxes', 'created'] as const

export interface OrgRow {
  id: string
  name: string
  subtitle: string
  envKind: string
  envVariant: 'success' | 'warning' | 'secondary'
  parentNote: string
  country: string
  currency: string
  activeUsers: string
  totalUsers: string
  sandboxes: string
}

export interface PlatformOrganizationsData {
  currentParams: Record<string, string | string[] | undefined>
  environmentOptions: { value: string; label: string; count: number }[]
  isEmpty: boolean
  hasRows: boolean
  rows: OrgRow[]
  total: number
  currentPage: number
  perPage: number
  sort: string
  dir: string
}

export async function loadPlatformOrganizations(
  sp: Record<string, string | string[] | undefined>,
): Promise<PlatformOrganizationsData> {
  const environmentParam = pickString(sp.environment)
  const environment =
    environmentParam === 'production' ||
    environmentParam === 'sandbox' ||
    environmentParam === 'preview'
      ? environmentParam
      : undefined
  const params = parseListParams(sp, {
    sort: 'name',
    dir: 'asc',
    perPage: 25,
    allowedSorts: SORTS,
  })
  const result = await platformOrganizations({ ...params, environment })

  return {
    currentParams: sp,
    environmentOptions: [
      { value: 'production', label: 'Production', count: result.environmentCounts.production ?? 0 },
      { value: 'sandbox', label: 'Sandbox', count: result.environmentCounts.sandbox ?? 0 },
      { value: 'preview', label: 'Preview', count: result.environmentCounts.preview ?? 0 },
    ],
    isEmpty: result.rows.length === 0,
    hasRows: result.rows.length > 0,
    rows: result.rows.map((org) => ({
      id: org.id,
      name: org.name,
      subtitle: org.legalName || org.id,
      envKind: org.envKind,
      envVariant:
        org.envKind === 'production' ? 'success' : org.envKind === 'sandbox' ? 'warning' : 'secondary',
      parentNote: org.parentName ? `of ${org.parentName}` : '',
      country: org.country,
      currency: org.baseCurrency,
      activeUsers: String(org.activeUserCount),
      totalUsers: String(org.userCount),
      sandboxes: String(org.sandboxCount),
    })),
    total: result.total,
    currentPage: params.page,
    perPage: params.perPage,
    sort: params.sort,
    dir: params.dir,
  }
}

const f = ref<PlatformOrganizationsData>()
const item = field

export function platformOrganizationsSpec(data: PlatformOrganizationsData): PageSpec {
  return page({
    route: '/platform/organizations',
    layout: 'list',
    header: [
      pageHeader({
        title: 'Organizations',
        description: 'Production companies and their isolated non-production environments.',
        back: { href: '/platform', label: 'Super Admin' },
      }),
      grid('flex flex-wrap items-center gap-2', [
        widgetBlock('search-input', {
          placeholder: 'Search name, legal name, country, or currency…',
        }),
        widgetBlock('filter-chips', {
          basePath: BASE,
          currentParams: data.currentParams,
          paramKey: 'environment',
          label: 'Environment',
          options: data.environmentOptions,
        }),
      ]),
    ],
    body: [
      {
        ...widgetBlock('empty-state', {
          icon: 'building',
          title: 'No organizations found',
          description: 'Try broadening the search or environment filter.',
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
                'Organization',
                widgetCell('org-name-cell', { name: item('name'), subtitle: item('subtitle') }),
                { sort: 'name' },
              ),
              column(
                'Environment',
                widgetCell('org-environment-cell', {
                  envKind: item('envKind'),
                  variant: item('envVariant'),
                  parentNote: item('parentNote'),
                }),
                { sort: 'environment' },
              ),
              column(
                'Country / currency',
                widgetCell('org-locale-cell', { country: item('country'), currency: item('currency') }),
              ),
              column(
                'Users',
                widgetCell('org-users-cell', { active: item('activeUsers'), total: item('totalUsers') }),
                { sort: 'users' },
              ),
              column('Sandboxes', text(item('sandboxes')), {
                sort: 'sandboxes',
                className: 'tabular-nums',
              }),
              column('Workspace', widgetCell('org-open-cell', { orgId: item('id') }), {
                align: 'right',
              }),
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

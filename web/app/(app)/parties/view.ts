import 'server-only'

import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import {
  badge,
  column,
  field,
  grid,
  link,
  page,
  pageHeader,
  pagination,
  ref,
  rootRef,
  table,
  text,
  widget,
  widgetBlock,
  widgetCell,
  type PageSpec,
} from '@openbooks/viewspec'
import { can, requirePermission } from '../../../lib/authz'
import { isFeatureEnabled } from '../../../lib/features'
import { buildListDrawerHref, isUuid, parseListParams, pickString } from '../../../lib/list-params'
import { loadFieldDefs } from '../../../lib/custom-fields'
import { loadParty } from '../../api/parties/_lib'
import { subsidiaryUiOptions, subsidiaryVisibleFilter } from '../../../lib/subsidiaries'
import { resolveFormLayout } from '../../../lib/customization/resolve'
import type { PartyDrawer, PartyTab } from './PartyDrawer'

/**
 * The party list, split into a loader and a spec.
 *
 * Two things this page settles that the earlier admin lists did not:
 *
 * 1. The role cell is three OPTIONAL badges inside one wrapper. That is a
 *    conditional composite, not a list, so it is a component (`PartyRolesCell`)
 *    and the loader decides which chips exist. The spec places a cell; it does
 *    not choose chips.
 * 2. The drawer keeps its remount key. The native page passes
 *    `key={party.id}` so switching parties resets client state, and a widget
 *    placed at a fixed position would otherwise reuse the mounted component.
 *    The key rides along as a prop and the registry applies it.
 *
 * The related-transaction drawer is placed through a slot that re-derives
 * `Authz` server-side — see RelatedTxnSlot. A capability object is not data and
 * never travels through a spec.
 */

const SORT_COLUMNS = {
  name: sql`p.display_name`,
  code: sql`p.short_code`,
} as const

type PartyDrawerProps = Parameters<typeof PartyDrawer>[0]
type ElementOf<T> = NonNullable<T> extends readonly (infer Item)[] ? Item : never

type PartyListRow = {
  id: string
  display_name: string
  short_code: string | null
  email: string | null
  phone: string | null
  is_active: boolean
  is_customer: boolean
  is_vendor: boolean
  is_employee: boolean
}
type PartyCounts = {
  total: string | number
  customers: string | number
  vendors: string | number
  employees: string | number
  active: string | number
  inactive: string | number
}

async function loadWorkerCompGroups(
  orgId: string,
): Promise<{ rows: ElementOf<PartyDrawerProps['workerCompGroups']>[] }> {
  if (!(await isFeatureEnabled(orgId, 'payroll'))) return { rows: [] }
  const result = await db.execute<ElementOf<PartyDrawerProps['workerCompGroups']>>(
    sql`select id, name from worker_comp_groups where org_id = ${orgId} and is_active order by name`,
  )
  return { rows: result.rows }
}

// A party is classified only by its active canonical role row.
const ROLE_CONDITIONS = {
  customer: sql`exists (select 1 from customer_roles r where r.party_id = p.id and r.org_id = p.org_id and r.is_active)`,
  vendor: sql`exists (select 1 from vendor_roles r where r.party_id = p.id and r.org_id = p.org_id and r.is_active)`,
  employee: sql`exists (select 1 from employee_roles r where r.party_id = p.id and r.org_id = p.org_id and r.is_active)`,
} as const

export interface PartyRoleBadge {
  label: string
  variant: 'default' | 'secondary' | 'outline'
}

export interface PartyRow {
  id: string
  name: string
  href: string
  shortCode: string
  roleBadges: PartyRoleBadge[]
  email: string
  phone: string
  statusLabel: string
  statusVariant: 'success' | 'outline'
}

export interface PartiesData {
  title: string
  description: string
  searchPlaceholder: string
  roleLabel: string
  currentParams: Record<string, string | string[] | undefined>
  roleOptions: { value: string; label: string; count: number }[]
  canManage: boolean
  isEmpty: boolean
  hasRows: boolean
  emptyTitle: string
  emptyDescription: string
  columnName: string
  columnShortCode: string
  columnRoles: string
  columnEmail: string
  columnPhone: string
  columnStatus: string
  rows: PartyRow[]
  total: number
  currentPage: number
  perPage: number
  sort: string
  dir: string
  showNewRedirect: boolean
  drawerOpen: boolean
  drawer: (Record<string, unknown> & { remountKey: string }) | null
  txnDrawerOpen: boolean
  txnDrawer: { id: string; kind: string; partyId: string; formLayoutId?: string } | null
}

export async function loadParties(
  sp: Record<string, string | string[] | undefined>,
): Promise<PartiesData> {
  const authz = await requirePermission('parties.read')
  const canManage = can(authz, 'parties.manage')
  const orgId = authz.user.orgId
  const t = await getTranslations('parties')
  const tc = await getTranslations('common')

  const partyId = typeof sp.party === 'string' ? sp.party : undefined
  const partyTransactionId = pickString(sp.partyTxn)
  const partyTransactionKind = pickString(sp.partyTxnKind)
  const requestedPartyTab = pickString(sp.partyTab)
  const partyTab: PartyTab =
    requestedPartyTab === 'transactions' ||
    requestedPartyTab === 'activities' ||
    requestedPartyTab === 'contacts' ||
    requestedPartyTab === 'addresses' ||
    requestedPartyTab === 'accounting' ||
    requestedPartyTab === 'wages'
      ? requestedPartyTab
      : 'overview'
  const params = parseListParams(sp, {
    sort: 'name',
    dir: 'asc',
    perPage: 25,
    allowedSorts: ['name', 'code'] as const,
  })
  const roleParam = pickString(sp.role)
  const role =
    roleParam === 'customer' || roleParam === 'vendor' || roleParam === 'employee'
      ? roleParam
      : undefined
  const showInactive = pickString(sp.showInactive) === 'true'

  const where = sql`p.org_id = ${orgId}
    ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, authz.allowedSubsidiaryIds, { orgWideNull: true })}
    ${
      params.q
        ? sql` and (p.display_name ilike ${'%' + params.q + '%'} or p.short_code ilike ${'%' + params.q + '%'} or p.email ilike ${'%' + params.q + '%'})`
        : sql``
    }
    ${role ? sql` and ${ROLE_CONDITIONS[role]}` : sql``}
    ${showInactive ? sql`` : sql` and p.is_active`}`

  const [parties, counts] = await Promise.all([
    db.execute<PartyListRow>(sql`
      select p.id, p.display_name, p.short_code, p.email, p.phone, p.is_active,
             ${ROLE_CONDITIONS.customer} as is_customer,
             ${ROLE_CONDITIONS.vendor} as is_vendor,
             ${ROLE_CONDITIONS.employee} as is_employee
        from parties p
       where ${where}
       order by ${SORT_COLUMNS[params.sort]} ${params.dir === 'asc' ? sql`asc` : sql`desc`} nulls last
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
    `),
    db.execute<PartyCounts>(sql`
      select count(*) as total,
             count(*) filter (where ${ROLE_CONDITIONS.customer}) as customers,
             count(*) filter (where ${ROLE_CONDITIONS.vendor}) as vendors,
             count(*) filter (where ${ROLE_CONDITIONS.employee}) as employees,
             count(*) filter (where p.is_active) as active,
             count(*) filter (where not p.is_active) as inactive
        from parties p
       where p.org_id = ${orgId}
         ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, authz.allowedSubsidiaryIds, { orgWideNull: true })} ${showInactive ? sql`` : sql`and p.is_active`}
    `),
  ])
  const c = counts.rows[0] ?? {
    total: 0,
    customers: 0,
    vendors: 0,
    employees: 0,
    active: 0,
    inactive: 0,
  }
  const total = Number(c.total)
  const filteredTotal =
    params.q || role
      ? Number(
          (
            await db.execute<{ n: string | number }>(
              sql`select count(*) as n from parties p where ${where}`,
            )
          ).rows[0]?.n ?? 0,
        )
      : total

  const [openParty, pickers, payrollEnabled, multiCurrency, crmEnabled] = await Promise.all([
    partyId && partyId !== 'new' && isUuid(partyId)
      ? loadParty(partyId, orgId, authz.allowedSubsidiaryIds)
      : null,
    partyId
      ? Promise.all([
          db.execute<ElementOf<PartyDrawerProps['paymentTerms']>>(
            sql`select id, name from payment_terms where org_id = ${orgId} and is_active order by name`,
          ),
          db.execute<ElementOf<PartyDrawerProps['departments']>>(
            sql`select id, name from departments where org_id = ${orgId} and is_active order by name`,
          ),
          db.execute<ElementOf<PartyDrawerProps['trades']>>(
            sql`select id, name from trades where org_id = ${orgId} and is_active order by name`,
          ),
          loadFieldDefs('parties'),
          subsidiaryUiOptions(orgId).then((options) =>
            authz.allowedSubsidiaryIds
              ? options.filter((option) => authz.allowedSubsidiaryIds!.has(option.id))
              : options,
          ),
          db.execute<ElementOf<PartyDrawerProps['accounts']>>(
            sql`select id, name, type, concat_ws(' · ', number, name) as label from accounts where org_id = ${orgId} and is_active and not is_summary order by number nulls last, name`,
          ),
          db.execute<ElementOf<PartyDrawerProps['taxCodes']>>(
            sql`select id, name, concat_ws(' · ', code, name) as label from tax_codes where org_id = ${orgId} and is_active order by code`,
          ),
          db.execute<ElementOf<PartyDrawerProps['salesReps']>>(
            sql`select p.id, p.display_name as name from parties p join employee_roles er on er.party_id = p.id and er.org_id = p.org_id and er.is_active where p.org_id = ${orgId} and p.is_active
            ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, authz.allowedSubsidiaryIds, { orgWideNull: true })} order by p.display_name`),
          loadWorkerCompGroups(orgId),
        ])
      : null,
    isFeatureEnabled(orgId, 'payroll'),
    isFeatureEnabled(orgId, 'multiCurrency'),
    isFeatureEnabled(orgId, 'crm'),
  ])
  const resolvedPartyForm =
    openParty && pickers && role
      ? await resolveFormLayout({
          orgId,
          userId: authz.user.id,
          recordType: role,
          userRoles: authz.user.roles.map(({ key }) => key),
          headerDefs: pickers[3],
          lineDefs: [],
          explicitLayoutId: pickString(sp.partyForm),
        })
      : null

  const drawer =
    openParty && pickers
      ? {
          remountKey: String(openParty.party.id),
          payload: openParty as unknown as PartyDrawerProps['payload'],
          paymentTerms: pickers[0].rows,
          departments: pickers[1].rows,
          trades: pickers[2].rows,
          workerCompGroups: pickers[8].rows,
          fieldDefs: pickers[3] as unknown as PartyDrawerProps['fieldDefs'],
          subsidiaries: pickers[4],
          accounts: pickers[5].rows,
          taxCodes: pickers[6].rows,
          salesReps: pickers[7].rows,
          canManage,
          canReadActivities: crmEnabled && can(authz, 'crm.activities.read'),
          canManageWages: can(authz, 'admin.setup.manage'),
          payrollEnabled,
          multiCurrency,
          initialTab: partyTab,
          initialMode: pickString(sp.mode) === 'edit' ? 'edit' : 'view',
          role,
          layout: resolvedPartyForm?.layout,
          forms: resolvedPartyForm?.available ?? [],
          currentFormId: resolvedPartyForm?.row?.id ?? null,
          recordType: role,
          canCustomize: can(authz, 'admin.customization.manage'),
        }
      : null

  const txnDrawer =
    openParty && partyTransactionId && isUuid(partyTransactionId) && partyTransactionKind
      ? {
          id: partyTransactionId,
          kind: partyTransactionKind,
          partyId: String(openParty.party.id),
          formLayoutId: pickString(sp.form),
        }
      : null

  return {
    title: t('list.title'),
    description: t('list.description'),
    searchPlaceholder: t('list.searchPlaceholder'),
    roleLabel: tc('labels.role'),
    currentParams: sp,
    roleOptions: [
      { value: 'customer', label: tc('labels.customer'), count: Number(c.customers) },
      { value: 'vendor', label: tc('labels.vendor'), count: Number(c.vendors) },
      { value: 'employee', label: tc('labels.employee'), count: Number(c.employees) },
    ],
    canManage,
    isEmpty: total === 0,
    hasRows: total > 0,
    emptyTitle: t('list.emptyTitle'),
    emptyDescription: t('list.emptyDescription'),
    columnName: tc('labels.name'),
    columnShortCode: t('list.shortCode'),
    columnRoles: t('list.roles'),
    columnEmail: tc('labels.email'),
    columnPhone: t('list.phone'),
    columnStatus: tc('labels.status'),
    rows: parties.rows.map((p) => ({
      id: String(p.id),
      name: p.display_name,
      href: buildListDrawerHref('/parties', sp, 'party', String(p.id)),
      shortCode: p.short_code ?? '',
      roleBadges: [
        ...(p.is_customer
          ? [{ label: tc('labels.customer'), variant: 'default' as const }]
          : []),
        ...(p.is_vendor ? [{ label: tc('labels.vendor'), variant: 'secondary' as const }] : []),
        ...(p.is_employee ? [{ label: tc('labels.employee'), variant: 'outline' as const }] : []),
      ],
      email: p.email ?? '',
      phone: p.phone ?? '',
      statusLabel: p.is_active ? tc('status.active') : tc('status.inactive'),
      statusVariant: p.is_active ? ('success' as const) : ('outline' as const),
    })),
    total: filteredTotal,
    currentPage: params.page,
    perPage: params.perPage,
    sort: params.sort,
    dir: params.dir,
    showNewRedirect: partyId === 'new' && canManage,
    drawerOpen: Boolean(drawer),
    drawer,
    txnDrawerOpen: Boolean(txnDrawer),
    txnDrawer,
  }
}

const f = ref<PartiesData>()
const item = field
const rootF = rootRef<PartiesData>()

export function partiesSpec(data: PartiesData): PageSpec {
  return page({
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actions: [widget('new-party', {}, f('canManage'))],
      }),
      grid('flex flex-wrap items-center gap-2', [
        widgetBlock('search-input', { placeholder: data.searchPlaceholder }),
        widgetBlock('filter-chips', {
          basePath: '/parties',
          currentParams: data.currentParams,
          paramKey: 'role',
          label: data.roleLabel,
          options: data.roleOptions,
        }),
        widgetBlock('show-inactives-toggle', {
          basePath: '/parties',
          currentParams: data.currentParams,
        }),
      ]),
    ],
    body: [
      {
        ...widgetBlock('empty-state', {
          title: data.emptyTitle,
          description: data.emptyDescription,
          action: data.canManage ? 'new-party' : null,
        }),
        when: f('isEmpty'),
      },
      {
        ...table({
          variant: 'app',
          rows: f('rows'),
          rowKey: item('id'),
          sorting: { basePath: '/parties', sort: f('sort'), dir: f('dir') },
          columns: [
            column(rootF('columnName'), link(item('name'), item('href'), 'text-teal-700 hover:underline dark:text-teal-300'), {
              sort: 'name',
              className: 'font-semibold',
            }),
            column(rootF('columnShortCode'), text(item('shortCode')), {
              sort: 'code',
              className: 'font-mono text-[13px]',
            }),
            column(
              rootF('columnRoles'),
              widgetCell('party-roles-cell', { badges: item('roleBadges') }),
            ),
            column(rootF('columnEmail'), text(item('email')), {
              className: 'text-slate-500 dark:text-slate-400',
            }),
            column(rootF('columnPhone'), text(item('phone')), {
              className: 'text-slate-500 dark:text-slate-400',
            }),
            column(
              rootF('columnStatus'),
              badge(item('statusLabel'), { variant: item('statusVariant') }),
            ),
          ],
        }),
        when: f('hasRows'),
      },
      {
        ...pagination({
          basePath: '/parties',
          total: f('total'),
          page: f('currentPage'),
          perPage: f('perPage'),
        }),
        when: f('hasRows'),
      },
      { ...widgetBlock('new-party-redirect', {}), when: f('showNewRedirect') },
      { ...widgetBlock('party-drawer', { drawer: data.drawer }), when: f('drawerOpen') },
      { ...widgetBlock('party-txn-drawer', { drawer: data.txnDrawer }), when: f('txnDrawerOpen') },
    ],
  })
}

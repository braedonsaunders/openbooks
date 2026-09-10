import 'server-only'

import { getMoneyFormatter } from '@/lib/money-server'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import {
  column,
  field,
  grid,
  money,
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
import { isUuid, mergeHref, parseListParams, pickString } from '../../../lib/list-params'
import { accountsWithBalances } from '../../../lib/data'
import { can, requirePermission } from '../../../lib/authz'
import { loadFieldDefs } from '../../../lib/custom-fields'
import { loadAccount } from '../../api/accounts/_lib'
import { segmentRegistry } from '../../../lib/segments'
import { isFeatureEnabled, subsidiaryFeatureEnabled } from '../../../lib/features'
import { accountParentPath, orderAccountHierarchy } from '../../../lib/account-hierarchy'
import { decimalAdd, decimalCmp, decimalSum } from '../../../lib/statement-format'
import type { HierarchyAccountGroup } from './AccountsHierarchyTable'
import type { AccountDrawer } from './AccountDrawer'

/**
 * The chart of accounts, split into a loader and a spec.
 *
 * Three mutually exclusive bodies — the customizable entity list, flat search
 * results, and the class hierarchy — chosen by three presence flags the LOADER
 * computes. The spec never asks which layout is active; it places three blocks
 * and exactly one of them survives. That is the whole "presence, not branching"
 * rule tested at its widest so far.
 *
 * The entity list itself arrives through a slot rather than as spec props,
 * because it needs an org id and a permission decision. Those are capabilities,
 * not data, and a spec that could name an org id is a cross-tenant read.
 */

// accounts.type enum → message key under accounts.types.* (unknown values render verbatim).
const TYPE_KEYS: Record<string, string> = {
  asset_bank: 'assetBank',
  asset_receivable: 'assetReceivable',
  asset_current_other: 'assetCurrentOther',
  asset_fixed: 'assetFixed',
  asset_other: 'assetOther',
  liability_payable: 'liabilityPayable',
  liability_card: 'liabilityCard',
  liability_current_other: 'liabilityCurrentOther',
  liability_long_term: 'liabilityLongTerm',
  equity: 'equity',
  income: 'income',
  income_other: 'incomeOther',
  cogs: 'cogs',
  expense: 'expense',
  expense_other: 'expenseOther',
  expense_deferred: 'expenseDeferred',
}
// Group the 16 detailed types into the 5 statement classes for the filter.
const CLASS_OF: Record<string, string> = {
  asset_bank: 'asset',
  asset_receivable: 'asset',
  asset_current_other: 'asset',
  asset_fixed: 'asset',
  asset_other: 'asset',
  liability_payable: 'liability',
  liability_card: 'liability',
  liability_current_other: 'liability',
  liability_long_term: 'liability',
  equity: 'equity',
  income: 'income',
  income_other: 'income',
  cogs: 'expense',
  expense: 'expense',
  expense_other: 'expense',
  expense_deferred: 'expense',
}
// statement class → message key under accounts.classes.* (unknown values render verbatim).
const CLASS_KEYS: Record<string, string> = {
  asset: 'asset',
  liability: 'liability',
  equity: 'equity',
  income: 'income',
  expense: 'expense',
}
const CLASS_ORDER = ['asset', 'liability', 'equity', 'income', 'expense'] as const

type AccountDrawerProps = Parameters<typeof AccountDrawer>[0]
type ParentOption = { id: string; number: string | null; name: string; type: string }
type CurrencyOption = { code: string; name: string }
type SubsidiaryOption = { id: string; name: string }
const FLAT_PER_PAGE = 50

export interface AccountSearchRow {
  id: string
  number: string
  name: string
  href: string
  isSummary: boolean
  inactiveLabel: string | null
  parentPath: string | null
  typeLabel: string
  balance: string
  balanceTone: 'negative' | 'default'
  registerAriaLabel: string
}

export interface AccountsData {
  title: string
  description: string
  newAccountLabel: string
  canManageAccounts: boolean
  currentParams: Record<string, string | string[] | undefined>
  searchPlaceholder: string
  classLabel: string
  classCounts: { value: string; label: string; count: number }[]
  viewTabs: { href: string; label: string; active: boolean }[]
  onList: boolean
  onSearch: boolean
  onHierarchy: boolean
  showFilters: boolean
  columnAccount: string
  columnType: string
  columnBalance: string
  columnActions: string
  viewRegisterLabel: string
  rows: AccountSearchRow[]
  total: number
  currentPage: number
  perPage: number
  groups: HierarchyAccountGroup[]
  hierarchyLabels: {
    account: string
    type: string
    balance: string
    actions: string
    inactive: string
    viewRegister: string
    expand: string
    collapse: string
  }
  drawerOpen: boolean
  /** The entity list renders its own drawer, so the page must not repeat it. */
  drawerOutsideList: boolean
  drawer: (Record<string, unknown> & { remountKey: string }) | null
}

export async function loadAccounts(
  sp: Record<string, string | string[] | undefined>,
): Promise<AccountsData> {
  const { money: formatMoney } = await getMoneyFormatter()
  const authz = await requirePermission('gl.read')
  const t = await getTranslations('accounts')
  const tc = await getTranslations('common')
  const typeLabel = (type: string) => (TYPE_KEYS[type] ? t(`types.${TYPE_KEYS[type]}`) : type)
  const layout = pickString(sp.layout) === 'hierarchy' ? 'hierarchy' : 'list'
  const params = parseListParams(sp, {
    sort: 'number',
    allowedSorts: ['number'] as const,
    perPage: FLAT_PER_PAGE,
  })
  const q = params.q?.toLowerCase()
  const cls = pickString(sp.class)
  const showInactive = pickString(sp.showInactive) === 'true'
  const accountId = pickString(sp.account)
  const canManageAccounts = can(authz, 'gl.manage')
  const creating = pickString(sp.accountNew) === '1' && canManageAccounts

  const accounts = await accountsWithBalances(
    authz.user.orgId,
    undefined,
    authz.allowedSubsidiaryIds,
  )
  const visibleAccounts = showInactive ? accounts : accounts.filter((account) => account.is_active)

  // roll balances up through summary parents (needed in both modes)
  const byId = new Map(accounts.map((a) => [a.id, a]))
  const rolled = new Map<string, string>(accounts.map((a) => [a.id, a.balance]))
  for (const a of accounts) {
    let p = a.parent_id
    const visited = new Set<string>()
    while (p && !visited.has(p)) {
      visited.add(p)
      rolled.set(p, decimalAdd(rolled.get(p) ?? '0.0000', a.balance))
      p = byId.get(p)?.parent_id ?? null
    }
  }

  const classCounts = Object.entries(
    visibleAccounts.reduce<Record<string, number>>((m, a) => {
      const c = CLASS_OF[a.type] ?? 'other'
      m[c] = (m[c] ?? 0) + 1
      return m
    }, {}),
  ).map(([value, count]) => ({
    value,
    label: CLASS_KEYS[value] ? t(`classes.${CLASS_KEYS[value]}`) : value,
    count,
  }))

  const [openAccount, subsidiaryUiEnabled, multiCurrencyEnabled] = await Promise.all([
    accountId && isUuid(accountId) ? loadAccount(accountId, authz.user.orgId) : null,
    subsidiaryFeatureEnabled(authz.user.orgId),
    isFeatureEnabled(authz.user.orgId, 'multiCurrency'),
  ])
  const drawerOptions =
    accountId || creating
      ? await Promise.all([
          db.execute<ParentOption>(sql`
          select id, number, name, type from accounts
           where org_id = ${authz.user.orgId} and is_summary
           order by number nulls last, name
        `),
          multiCurrencyEnabled
            ? db.execute<CurrencyOption>(sql`select code, name from currencies order by code`)
            : Promise.resolve({ rows: [] as CurrencyOption[] }),
          db.execute<SubsidiaryOption>(sql`
          select id, name from subsidiaries
           where org_id = ${authz.user.orgId}
           order by name
        `),
          loadFieldDefs('accounts'),
          segmentRegistry(authz.user.orgId),
        ])
      : null
  const requestedReturn = pickString(sp.drawerReturn)
  const closeHref = requestedReturn?.startsWith('/accounts')
    ? requestedReturn
    : mergeHref('/accounts', sp, {
        account: undefined,
        accountNew: undefined,
        drawerReturn: undefined,
      })
  const drawerPayload = creating
    ? {
        account: {
          id: '',
          number: '',
          name: '',
          type: 'expense',
          description: '',
          parent_id: null,
          is_summary: false,
          is_active: true,
          currency_restriction: null,
          eliminate: false,
          subsidiary_id: null,
          subsidiary_include_children: true,
          reconcilable: false,
          required_dimensions: [],
          custom: {},
        },
        parentName: null,
        subsidiaryName: null,
        hasTransactions: false,
        childCount: 0,
        activeChildCount: 0,
      }
    : openAccount
  const drawer =
    drawerPayload && drawerOptions
      ? {
          remountKey: creating ? 'new-account' : String(drawerPayload.account.id),
          payload: drawerPayload,
          parents: drawerOptions[0].rows
            .filter((option) => option.id !== drawerPayload.account.id)
            .map((option) => ({
              value: option.id,
              label: `${option.number ?? ''} ${option.name}`.trim(),
              type: option.type,
            })),
          currencies: drawerOptions[1].rows.map((option) => ({
            value: option.code,
            label: `${option.code} · ${option.name}`,
          })),
          subsidiaries: (subsidiaryUiEnabled ? drawerOptions[2].rows : []).map((option) => ({
            value: option.id,
            label: option.name,
          })),
          fieldDefs: drawerOptions[3] as AccountDrawerProps['fieldDefs'],
          segments: (drawerOptions[4] as Awaited<ReturnType<typeof segmentRegistry>>)
            .filter((segment) => segment.allowAccountRequirement)
            .map((segment) => ({ key: segment.key, name: segment.name })),
          canManage: canManageAccounts,
          closeHref,
          createMode: creating,
          multiCurrency: multiCurrencyEnabled,
          multiSubsidiary: subsidiaryUiEnabled,
        }
      : null

  // ---- searched → flat, paginated results with hierarchy context ----------
  const matches =
    layout === 'hierarchy' && q
      ? visibleAccounts
          .filter(
            (a) =>
              (!cls || CLASS_OF[a.type] === cls) &&
              (!q ||
                (a.number ?? '').toLowerCase().includes(q) ||
                a.name.toLowerCase().includes(q)),
          )
          .sort((a, b) => (a.number ?? '').localeCompare(b.number ?? ''))
      : []
  const pageRows = matches.slice((params.page - 1) * FLAT_PER_PAGE, params.page * FLAT_PER_PAGE)

  // ---- default → five statement classes containing the account hierarchy --
  const groups: HierarchyAccountGroup[] =
    layout === 'hierarchy' && !q
      ? CLASS_ORDER.filter((classKey) => !cls || cls === classKey)
          .map((classKey) => {
            const {
              members: classAccounts,
              ordered,
              parentIds,
            } = orderAccountHierarchy(visibleAccounts, classKey, CLASS_OF)
            const classBalance = decimalSum(classAccounts.map((account) => account.balance))
            return {
              key: classKey,
              label: t(`classes.${CLASS_KEYS[classKey]}`),
              count: classAccounts.length,
              balance: formatMoney(classBalance),
              balanceNegative: decimalCmp(classBalance, '0.0000') < 0,
              rows: ordered.map((account) => {
                const balance = rolled.get(account.id) ?? '0.0000'
                return {
                  id: account.id,
                  parentId: parentIds.get(account.id) ?? null,
                  number: account.number ?? tc('labels.notSet'),
                  name: account.name,
                  typeLabel: typeLabel(account.type),
                  isSummary: account.is_summary,
                  isActive: account.is_active,
                  balance: formatMoney(balance),
                  balanceNegative: decimalCmp(balance, '0.0000') < 0,
                  detailHref: mergeHref('/accounts', sp, {
                    account: account.id,
                    accountNew: undefined,
                  }),
                }
              }),
            }
          })
          .filter((group) => group.count > 0)
      : []

  return {
    title: t('list.title'),
    description: t('list.description'),
    newAccountLabel: t('list.newAccount'),
    canManageAccounts,
    currentParams: sp,
    searchPlaceholder: t('list.searchPlaceholder'),
    classLabel: tc('labels.class'),
    classCounts,
    viewTabs: [
      { href: '/accounts', label: t('list.views.list'), active: layout === 'list' },
      {
        href: '/accounts?layout=hierarchy',
        label: t('list.views.hierarchy'),
        active: layout === 'hierarchy',
      },
    ],
    onList: layout === 'list',
    onSearch: layout === 'hierarchy' && Boolean(q),
    onHierarchy: layout === 'hierarchy' && !q,
    showFilters: layout === 'hierarchy',
    columnAccount: tc('labels.account'),
    columnType: tc('labels.type'),
    columnBalance: tc('labels.balance'),
    columnActions: tc('labels.actions'),
    viewRegisterLabel: t('list.viewRegister'),
    rows: pageRows.map((a) => {
      const bal = rolled.get(a.id) ?? '0.0000'
      const parentPath = accountParentPath(a, byId)
      return {
        id: a.id,
        number: a.number ?? tc('labels.notSet'),
        name: a.name,
        href: mergeHref('/accounts', sp, { account: a.id }),
        isSummary: a.is_summary,
        inactiveLabel: a.is_active ? null : t('list.badges.inactive'),
        parentPath: parentPath ? parentPath : null,
        typeLabel: typeLabel(a.type),
        balance: formatMoney(bal),
        balanceTone: decimalCmp(bal, '0.0000') < 0 ? ('negative' as const) : ('default' as const),
        registerAriaLabel: `${t('list.viewRegister')}: ${a.number ?? ''} ${a.name}`.trim(),
      }
    }),
    total: matches.length,
    currentPage: params.page,
    perPage: FLAT_PER_PAGE,
    groups,
    hierarchyLabels: {
      account: tc('labels.account'),
      type: tc('labels.type'),
      balance: tc('labels.balance'),
      actions: tc('labels.actions'),
      inactive: t('list.badges.inactive'),
      viewRegister: t('list.viewRegister'),
      expand: t('list.expand'),
      collapse: t('list.collapse'),
    },
    drawerOpen: Boolean(drawer),
    drawerOutsideList: Boolean(drawer) && layout !== 'list',
    drawer,
  }
}

const f = ref<AccountsData>()
const item = field
const rootF = rootRef<AccountsData>()

export function accountsSpec(data: AccountsData): PageSpec {
  const newAccount = {
    widget: 'new-account',
    props: { currentParams: data.currentParams, label: data.newAccountLabel },
  }
  return page({
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actionsClassName: 'flex items-center gap-3',
        actions: [
          widget('module-home-tabs', { tabs: data.viewTabs }),
          widget(newAccount.widget, newAccount.props, f('canManageAccounts')),
        ],
      }),
      {
        ...grid('flex flex-wrap items-center gap-2', [
          widgetBlock('search-input', { placeholder: data.searchPlaceholder }),
          widgetBlock('filter-chips', {
            basePath: '/accounts',
            currentParams: data.currentParams,
            paramKey: 'class',
            label: data.classLabel,
            options: data.classCounts,
          }),
          widgetBlock('show-inactives-toggle', {
            basePath: '/accounts',
            currentParams: data.currentParams,
          }),
        ]),
        when: f('showFilters'),
      },
    ],
    body: [
      {
        ...widgetBlock('entity-list-view', {
          recordType: 'account',
          sp: data.currentParams,
          drawer: data.drawer ? { widget: 'account-drawer', props: { drawer: data.drawer } } : null,
          emptyAction: data.canManageAccounts ? newAccount : null,
        }),
        when: f('onList'),
      },
      {
        ...table({
          variant: 'app',
          rows: f('rows'),
          rowKey: item('id'),
          columns: [
            column(
              rootF('columnAccount'),
              widgetCell('account-name-cell', {
                number: item('number'),
                name: item('name'),
                href: item('href'),
                isSummary: item('isSummary'),
                inactiveLabel: item('inactiveLabel'),
                parentPath: item('parentPath'),
              }),
            ),
            column(rootF('columnType'), text(item('typeLabel')), {
              className: 'text-slate-500 dark:text-slate-400',
            }),
            column(rootF('columnBalance'), money(item('balance'), { tone: item('balanceTone') }), {
              align: 'right',
            }),
            column(
              rootF('columnActions'),
              widgetCell('account-register-cell', {
                accountId: item('id'),
                ariaLabel: item('registerAriaLabel'),
                title: rootF('viewRegisterLabel'),
              }),
              // `align` would put `text-right` on the header too; the native
              // header carries only its width.
              { className: 'text-right', headerClassName: 'w-14', srOnlyHeader: true },
            ),
          ],
        }),
        when: f('onSearch'),
      },
      {
        ...pagination({
          basePath: '/accounts',
          total: f('total'),
          page: f('currentPage'),
          perPage: f('perPage'),
        }),
        when: f('onSearch'),
      },
      {
        ...widgetBlock('accounts-hierarchy', {
          groups: data.groups,
          labels: data.hierarchyLabels,
        }),
        when: f('onHierarchy'),
      },
      // The entity list renders the drawer itself, so only the other two
      // layouts place it here — the same arrangement the native page has.
      {
        ...widgetBlock('account-drawer', { drawer: data.drawer }),
        when: f('drawerOutsideList'),
      },
    ],
  })
}

import { getMoneyFormatter } from '@/lib/money-server'
import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { BookOpenText } from 'lucide-react'
import { Badge, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { EntityListView } from '../../../components/entity-list-view'
import { SearchInput } from '../../../components/search-input'
import { FilterChips } from '../../../components/filter-bar'
import { ShowInactivesToggle } from '../../../components/show-inactives-toggle'
import { Pagination } from '../../../components/pagination'
import { isUuid, mergeHref, parseListParams, pickString } from '../../../lib/list-params'
import { accountsWithBalances } from '../../../lib/data'
import { can, requirePermission } from '../../../lib/authz'
import { loadFieldDefs } from '../../../lib/custom-fields'
import { loadAccount } from '../../api/accounts/_lib'
import { AccountDrawer } from './AccountDrawer'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { segmentRegistry } from '../../../lib/segments'
import { subsidiaryFeatureEnabled } from '../../../lib/features'
import { AccountRegisterLink } from '../../../components/account-register-link'
import { NewAccountButton } from './NewAccountButton'
import { AccountsHierarchyTable, type HierarchyAccountGroup } from './AccountsHierarchyTable'
import { accountParentPath, orderAccountHierarchy } from '../../../lib/account-hierarchy'
import { ModuleHomeTabs } from '../../../components/module-home/ui'

export const dynamic = 'force-dynamic'

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
  asset_bank: 'asset', asset_receivable: 'asset', asset_current_other: 'asset', asset_fixed: 'asset', asset_other: 'asset',
  liability_payable: 'liability', liability_card: 'liability', liability_current_other: 'liability', liability_long_term: 'liability',
  equity: 'equity',
  income: 'income', income_other: 'income',
  cogs: 'expense', expense: 'expense', expense_other: 'expense', expense_deferred: 'expense',
}
// statement class → message key under accounts.classes.* (unknown values render verbatim).
const CLASS_KEYS: Record<string, string> = { asset: 'asset', liability: 'liability', equity: 'equity', income: 'income', expense: 'expense' }
const CLASS_ORDER = ['asset', 'liability', 'equity', 'income', 'expense'] as const
const FLAT_PER_PAGE = 50

export default async function Accounts({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { money } = await getMoneyFormatter()
  const authz = await requirePermission('gl.read')
  const t = await getTranslations('accounts')
  const tc = await getTranslations('common')
  const typeLabel = (type: string) => (TYPE_KEYS[type] ? t(`types.${TYPE_KEYS[type]}`) : type)
  const sp = await searchParams
  const layout = pickString(sp.layout) === 'hierarchy' ? 'hierarchy' : 'list'
  const params = parseListParams(sp, { sort: 'number', allowedSorts: ['number'] as const, perPage: FLAT_PER_PAGE })
  const q = params.q?.toLowerCase()
  const cls = pickString(sp.class)
  const showInactive = pickString(sp.showInactive) === 'true'
  const accountId = pickString(sp.account)
  const canManageAccounts = can(authz, 'gl.manage')
  const creating = pickString(sp.accountNew) === '1' && canManageAccounts

  const accounts = await accountsWithBalances(authz.user.orgId)
  const visibleAccounts = showInactive ? accounts : accounts.filter((account) => account.is_active)

  // roll balances up through summary parents (needed in both modes)
  const byId = new Map(accounts.map((a) => [a.id, a]))
  const rolled = new Map<string, number>(accounts.map((a) => [a.id, Number(a.balance)]))
  for (const a of accounts) {
    let p = a.parent_id
    const visited = new Set<string>()
    while (p && !visited.has(p)) {
      visited.add(p)
      rolled.set(p, (rolled.get(p) ?? 0) + Number(a.balance))
      p = byId.get(p)?.parent_id ?? null
    }
  }

  const classCounts = Object.entries(
    visibleAccounts.reduce<Record<string, number>>((m, a) => {
      const c = CLASS_OF[a.type] ?? 'other'
      m[c] = (m[c] ?? 0) + 1
      return m
    }, {}),
  ).map(([value, count]) => ({ value, label: CLASS_KEYS[value] ? t(`classes.${CLASS_KEYS[value]}`) : value, count }))

  const [openAccount, drawerOptions, subsidiaryUiEnabled] = await Promise.all([
    accountId && isUuid(accountId) ? loadAccount(accountId, authz.user.orgId) : null,
    accountId || creating
      ? Promise.all([
          db.execute(sql`
            select id, number, name, type from accounts
             where org_id = ${authz.user.orgId} and is_summary
             order by number nulls last, name
          `) as any,
          db.execute(sql`select code, name from currencies order by code`) as any,
          db.execute(sql`
            select id, name from subsidiaries
             where org_id = ${authz.user.orgId}
             order by name
          `) as any,
          loadFieldDefs('accounts'),
          segmentRegistry(authz.user.orgId),
        ])
      : null,
    subsidiaryFeatureEnabled(authz.user.orgId),
  ])
  const requestedReturn = pickString(sp.drawerReturn)
  const closeHref = requestedReturn?.startsWith('/accounts')
    ? requestedReturn
    : mergeHref('/accounts', sp, { account: undefined, accountNew: undefined, drawerReturn: undefined })
  const drawerPayload = creating ? {
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
  } : openAccount
  const drawer = drawerPayload && drawerOptions ? (
    <AccountDrawer
      key={creating ? 'new-account' : String(drawerPayload.account.id)}
      payload={drawerPayload}
      parents={drawerOptions[0].rows
        .filter((option: any) => option.id !== drawerPayload.account.id)
        .map((option: any) => ({ value: option.id, label: `${option.number ?? ''} ${option.name}`.trim(), type: option.type }))}
      currencies={drawerOptions[1].rows.map((option: any) => ({ value: option.code, label: `${option.code} · ${option.name}` }))}
      subsidiaries={(subsidiaryUiEnabled ? drawerOptions[2].rows : []).map((option: any) => ({ value: option.id, label: option.name }))}
      fieldDefs={drawerOptions[3] as any}
      segments={(drawerOptions[4] as Awaited<ReturnType<typeof segmentRegistry>>)
        .filter((segment) => segment.allowAccountRequirement)
        .map((segment) => ({ key: segment.key, name: segment.name }))}
      canManage={canManageAccounts}
      closeHref={closeHref}
      createMode={creating}
    />
  ) : null

  const viewTabs = (
    <ModuleHomeTabs
      tabs={[
        { href: '/accounts', label: t('list.views.list'), active: layout === 'list' },
        { href: '/accounts?layout=hierarchy', label: t('list.views.hierarchy'), active: layout === 'hierarchy' },
      ]}
    />
  )
  const headerActions = (
    <div className="flex items-center gap-3">
      {viewTabs}
      {canManageAccounts ? <NewAccountButton currentParams={sp} label={t('list.newAccount')} /> : null}
    </div>
  )
  const header = (
    <>
      <PageHeader
        title={t('list.title')}
        description={t('list.description')}
        actions={headerActions}
      />
      {layout === 'hierarchy' ? (
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput placeholder={t('list.searchPlaceholder')} />
          <FilterChips basePath="/accounts" currentParams={sp} paramKey="class" label={tc('labels.class')} options={classCounts} />
          <ShowInactivesToggle basePath="/accounts" currentParams={sp} />
        </div>
      ) : null}
    </>
  )

  if (layout === 'list') {
    return (
      <ListPageLayout header={header}>
        <EntityListView
          recordType="account"
          orgId={authz.user.orgId}
          userId={authz.user.id}
          canManage={can(authz, 'admin.customization.manage')}
          sp={sp}
          drawer={drawer}
          emptyAction={canManageAccounts ? <NewAccountButton currentParams={sp} label={t('list.newAccount')} /> : undefined}
        />
      </ListPageLayout>
    )
  }

  // ---- searched → flat, paginated results with hierarchy context ----------
  if (q) {
    const matches = visibleAccounts
      .filter((a) => (!cls || CLASS_OF[a.type] === cls) && (!q || (a.number ?? '').toLowerCase().includes(q) || a.name.toLowerCase().includes(q)))
      .sort((a, b) => (a.number ?? '').localeCompare(b.number ?? ''))
    const total = matches.length
    const pageRows = matches.slice((params.page - 1) * FLAT_PER_PAGE, params.page * FLAT_PER_PAGE)
    return (
      <ListPageLayout header={header}>
        <Table>
          <TableHeader>
            <TableRow noAnimate>
              <TableHead>{tc('labels.account')}</TableHead>
              <TableHead>{tc('labels.type')}</TableHead>
              <TableHead className="text-right">{tc('labels.balance')}</TableHead>
              <TableHead className="w-14"><span className="sr-only">{tc('labels.actions')}</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pageRows.map((a) => {
              const bal = rolled.get(a.id) ?? 0
              return (
                <TableRow key={a.id}>
                  <TableCell>
                    <div className="flex min-w-0 items-start">
                      <span className="mr-3 w-20 shrink-0 pt-0.5 font-mono text-xs text-slate-500 dark:text-slate-400">
                        {a.number ?? tc('labels.notSet')}
                      </span>
                      <div className="min-w-0">
                        <Link href={mergeHref('/accounts', sp, { account: a.id }) as any} className={cn('hover:text-teal-700 hover:underline dark:hover:text-teal-300', a.is_summary && 'font-semibold')}>
                          {a.name}
                        </Link>
                        {!a.is_active ? <Badge variant="outline" className="ml-2">{t('list.badges.inactive')}</Badge> : null}
                        {accountParentPath(a, byId) ? <p className="mt-0.5 truncate text-xs text-slate-400 dark:text-slate-500">{accountParentPath(a, byId)}</p> : null}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-slate-500 dark:text-slate-400">{typeLabel(a.type)}</TableCell>
                  <TableCell className={cn('text-right tabular-nums', bal < 0 && 'text-red-600 dark:text-red-400')}>
                    {money(bal)}
                  </TableCell>
                  <TableCell className="text-right">
                    <AccountRegisterLink
                      accountId={a.id}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-teal-700 dark:hover:bg-slate-800 dark:hover:text-teal-300"
                      ariaLabel={`${t('list.viewRegister')}: ${a.number ?? ''} ${a.name}`.trim()}
                      title={t('list.viewRegister')}
                    >
                      <BookOpenText size={15} />
                    </AccountRegisterLink>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
        <div className="mt-3">
          <Pagination basePath="/accounts" currentParams={sp} total={total} page={params.page} perPage={FLAT_PER_PAGE} />
        </div>
        {drawer}
      </ListPageLayout>
    )
  }

  // ---- default → five statement classes containing the account hierarchy --
  const groups: HierarchyAccountGroup[] = CLASS_ORDER
    .filter((classKey) => !cls || cls === classKey)
    .map((classKey) => {
      const { members: classAccounts, ordered, parentIds } = orderAccountHierarchy(visibleAccounts, classKey, CLASS_OF)
      const classBalance = classAccounts.reduce((sum, account) => sum + Number(account.balance), 0)
      return {
        key: classKey,
        label: t(`classes.${CLASS_KEYS[classKey]}`),
        count: classAccounts.length,
        balance: money(classBalance),
        balanceNegative: classBalance < 0,
        rows: ordered.map((account) => {
          const balance = rolled.get(account.id) ?? 0
          return {
            id: account.id,
            parentId: parentIds.get(account.id) ?? null,
            number: account.number ?? tc('labels.notSet'),
            name: account.name,
            typeLabel: typeLabel(account.type),
            isSummary: account.is_summary,
            isActive: account.is_active,
            balance: money(balance),
            balanceNegative: balance < 0,
            detailHref: mergeHref('/accounts', sp, { account: account.id, accountNew: undefined }),
          }
        }),
      }
    })
    .filter((group) => group.count > 0)

  return (
    <ListPageLayout header={header}>
      <AccountsHierarchyTable
        groups={groups}
        labels={{
          account: tc('labels.account'),
          type: tc('labels.type'),
          balance: tc('labels.balance'),
          actions: tc('labels.actions'),
          inactive: t('list.badges.inactive'),
          viewRegister: t('list.viewRegister'),
          expand: t('list.expand'),
          collapse: t('list.collapse'),
        }}
      />
      {drawer}
    </ListPageLayout>
  )
}

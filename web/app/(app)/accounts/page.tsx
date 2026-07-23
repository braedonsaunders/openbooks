import { getMoneyFormatter } from '@/lib/money-server'
import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { Badge, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
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
  const params = parseListParams(sp, { sort: 'number', allowedSorts: ['number'] as const, perPage: FLAT_PER_PAGE })
  const q = params.q?.toLowerCase()
  const cls = pickString(sp.class)
  const showInactive = pickString(sp.showInactive) === 'true'
  const accountId = pickString(sp.account)
  const filtering = !!q || !!cls

  const accounts = await accountsWithBalances(authz.user.orgId)
  const visibleAccounts = showInactive ? accounts : accounts.filter((account) => account.is_active)

  // roll balances up through summary parents (needed in both modes)
  const byId = new Map(accounts.map((a) => [a.id, a]))
  const visibleById = new Map(visibleAccounts.map((a) => [a.id, a]))
  const rolled = new Map<string, number>(accounts.map((a) => [a.id, Number(a.balance)]))
  for (const a of accounts) {
    let p = a.parent_id
    while (p) {
      rolled.set(p, (rolled.get(p) ?? 0) + Number(a.balance))
      p = byId.get(p)?.parent_id ?? null
    }
  }
  const depth = (a: (typeof accounts)[number]) => {
    let d = 0, p = a.parent_id
    while (p && visibleById.has(p)) { d++; p = visibleById.get(p)?.parent_id ?? null }
    return Math.min(d, 2)
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
    accountId
      ? Promise.all([
          db.execute(sql`
            select id, number, name from accounts
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
  const closeHref = mergeHref('/accounts', sp, { account: undefined })
  const drawer = openAccount && drawerOptions ? (
    <AccountDrawer
      key={String(openAccount.account.id)}
      payload={openAccount}
      parents={drawerOptions[0].rows
        .filter((option: any) => option.id !== openAccount.account.id)
        .map((option: any) => ({ value: option.id, label: `${option.number ?? ''} ${option.name}`.trim() }))}
      currencies={drawerOptions[1].rows.map((option: any) => ({ value: option.code, label: `${option.code} · ${option.name}` }))}
      subsidiaries={(subsidiaryUiEnabled ? drawerOptions[2].rows : []).map((option: any) => ({ value: option.id, label: option.name }))}
      fieldDefs={drawerOptions[3] as any}
      segments={(drawerOptions[4] as Awaited<ReturnType<typeof segmentRegistry>>)
        .filter((segment) => segment.allowAccountRequirement)
        .map((segment) => ({ key: segment.key, name: segment.name }))}
      canManage={can(authz, 'gl.manage')}
      closeHref={closeHref}
    />
  ) : null

  const header = (
    <>
      <PageHeader
        title={t('list.title')}
        description={t('list.description')}
      />
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput placeholder={t('list.searchPlaceholder')} />
        <FilterChips basePath="/accounts" currentParams={sp} paramKey="class" label={tc('labels.class')} options={classCounts} />
        <ShowInactivesToggle basePath="/accounts" currentParams={sp} />
      </div>
    </>
  )

  // ---- filtered/searched → flat, paginated list ---------------------------
  if (filtering) {
    const matches = visibleAccounts
      .filter((a) => (!cls || CLASS_OF[a.type] === cls) && (!q || (a.number ?? '').toLowerCase().includes(q) || a.name.toLowerCase().includes(q)))
      .sort((a, b) => (a.number ?? '').localeCompare(b.number ?? ''))
    const total = matches.length
    const pageRows = matches.slice((params.page - 1) * FLAT_PER_PAGE, params.page * FLAT_PER_PAGE)
    return (
      <ListPageLayout header={header}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-24">{tc('labels.number')}</TableHead>
              <TableHead>{tc('labels.account')}</TableHead>
              <TableHead>{tc('labels.type')}</TableHead>
              <TableHead className="text-right">{tc('labels.balance')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pageRows.map((a) => {
              const bal = rolled.get(a.id) ?? 0
              return (
                <TableRow key={a.id}>
                  <TableCell className="font-mono text-xs">
                    <Link href={`/accounts/${a.id}`} className="text-teal-700 hover:underline dark:text-teal-300">{a.number ?? tc('labels.notSet')}</Link>
                  </TableCell>
                  <TableCell>
                    <Link href={mergeHref('/accounts', sp, { account: a.id }) as any} className={cn('hover:text-teal-700 dark:hover:text-teal-300', a.is_summary && 'font-semibold')}>
                      {a.name}
                    </Link>
                    {!a.is_active ? <Badge variant="outline" className="ml-2">{t('list.badges.inactive')}</Badge> : null}
                  </TableCell>
                  <TableCell className="text-slate-500 dark:text-slate-400">{typeLabel(a.type)}</TableCell>
                  <TableCell className={cn('text-right tabular-nums', bal < 0 && 'text-red-600 dark:text-red-400')}>
                    <Link href={`/accounts/${a.id}`} className="hover:underline">{money(bal)}</Link>
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

  // ---- default → the hierarchy tree, grouped by type ----------------------
  const children = new Map<string | null, typeof visibleAccounts>()
  for (const a of visibleAccounts) {
    const visibleParent = a.parent_id && visibleById.has(a.parent_id) ? a.parent_id : null
    if (!children.has(visibleParent)) children.set(visibleParent, [])
    children.get(visibleParent)!.push(a)
  }
  const ordered: typeof visibleAccounts = []
  const walk = (parent: string | null) => {
    for (const a of children.get(parent) ?? []) { ordered.push(a); walk(a.id) }
  }
  walk(null)
  let currentType = ''

  return (
    <ListPageLayout header={header}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-24">{tc('labels.number')}</TableHead>
            <TableHead>{tc('labels.account')}</TableHead>
            <TableHead className="text-right">{tc('labels.balance')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {ordered.map((a) => {
            const bal = rolled.get(a.id) ?? 0
            const showHeader = a.type !== currentType && (!a.parent_id || !visibleById.has(a.parent_id))
            if (showHeader) currentType = a.type
            const d = depth(a)
            return [
              showHeader ? (
                <TableRow key={`${a.id}-h`}>
                  <TableCell colSpan={3} className="bg-slate-50 text-xs font-semibold tracking-wide text-slate-600 uppercase dark:bg-slate-900 dark:text-slate-300">
                    {typeLabel(a.type)}
                  </TableCell>
                </TableRow>
              ) : null,
              <TableRow key={a.id}>
                <TableCell className="font-mono text-xs">
                  <Link href={`/accounts/${a.id}`} className="text-teal-700 hover:underline dark:text-teal-300">{a.number ?? tc('labels.notSet')}</Link>
                </TableCell>
                <TableCell className={cn(d === 1 && 'pl-8', d === 2 && 'pl-12')}>
                  <Link href={mergeHref('/accounts', sp, { account: a.id }) as any} className={cn('hover:text-teal-700 dark:hover:text-teal-300', a.is_summary && 'font-semibold')}>
                    {a.name}
                  </Link>
                  {!a.is_active ? <Badge variant="outline" className="ml-2">{t('list.badges.inactive')}</Badge> : null}
                  {a.is_summary ? <Badge variant="secondary" className="ml-2">{t('list.badges.summary')}</Badge> : null}
                </TableCell>
                <TableCell className={cn('text-right tabular-nums', bal < 0 && 'text-red-600 dark:text-red-400')}>
                  <Link href={`/accounts/${a.id}`} className="hover:underline">{money(bal)}</Link>
                </TableCell>
              </TableRow>,
            ]
          })}
        </TableBody>
      </Table>
      {drawer}
    </ListPageLayout>
  )
}

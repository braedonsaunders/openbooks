import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { Badge, EmptyState, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { SearchInput } from '../../../../components/search-input'
import { FilterChips } from '../../../../components/filter-bar'
import { Pagination } from '../../../../components/pagination'
import { SortTh } from '../../../../components/sortable-th'
import { requirePermission } from '../../../../lib/authz'
import { parseListParams, pickString, isUuid } from '../../../../lib/list-params'
import { RuleDrawer, NewRuleButton, RunRulesButton } from './RuleDrawer'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('banking')
  return { title: t('rules.title') }
}

const SORT_COLUMNS = {
  name: sql`r.name`,
  priority: sql`r.priority`,
  created: sql`r.created_at`,
} as const

export default async function BankingRules({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('banking.reconcile')
  const t = await getTranslations('banking')
  const tCommon = await getTranslations('common')
  const sp = await searchParams

  const params = parseListParams(sp, {
    sort: 'priority',
    dir: 'asc',
    perPage: 25,
    allowedSorts: ['name', 'priority', 'created'] as const,
  })
  const active = pickString(sp.active)
  const where = sql`r.org_id = ${authz.user.orgId}
    ${active === 'true' ? sql` and r.is_active` : active === 'false' ? sql` and not r.is_active` : sql``}
    ${params.q ? sql` and r.name ilike ${'%' + params.q + '%'}` : sql``}`

  const openId = pickString(sp.rule)

  const [rows, count, activeCounts, offsetAccounts, reconAccounts, open] = (await Promise.all([
    db.execute(sql`
      select r.id, r.name, r.criteria, r.outcome, r.priority, r.is_active
        from bank_match_rules r
       where ${where}
       order by ${SORT_COLUMNS[params.sort]} ${params.dir === 'asc' ? sql`asc` : sql`desc`} nulls last
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
    `),
    db.execute(sql`select count(*) as n from bank_match_rules r where ${where}`),
    db.execute(sql`
      select r.is_active, count(*) as n from bank_match_rules r
       where r.org_id = ${authz.user.orgId} group by r.is_active
    `),
    db.execute(sql`
      select id, number, name from accounts
       where org_id = ${authz.user.orgId} and is_active and not is_summary
       order by number nulls last limit 2000
    `),
    db.execute(sql`
      select id, number, name from accounts
       where org_id = ${authz.user.orgId} and reconcilable and not is_summary and is_active
       order by number nulls last
    `),
    openId && openId !== 'new' && isUuid(openId)
      ? db.execute(sql`
          select id, name, criteria, outcome, priority, is_active
            from bank_match_rules where id = ${openId} and org_id = ${authz.user.orgId}
        `)
      : Promise.resolve({ rows: [] }),
  ])) as unknown as { rows: any[] }[]

  const total = Number(count.rows[0].n)
  const activeMap = new Map(activeCounts.rows.map((r: any) => [r.is_active, Number(r.n)]))
  const activeOptions = [
    { value: 'true', label: tCommon('labels.active'), count: activeMap.get(true) ?? 0 },
    { value: 'false', label: t('rules.inactive'), count: activeMap.get(false) ?? 0 },
  ].filter((o) => o.count > 0)

  const accountOpts = offsetAccounts.rows.map((a: any) => ({
    id: a.id,
    label: [a.number, a.name].filter(Boolean).join(' · '),
  }))
  const reconAccountOpts = reconAccounts.rows.map((a: any) => ({
    id: a.id,
    label: [a.number, a.name].filter(Boolean).join(' · '),
  }))

  const openRule = openId === 'new' ? null : (open.rows[0] ?? null)
  const drawerOpen = openId === 'new' || !!open.rows[0]

  return (
    <ListPageLayout
      header={
        <PageHeader
          back={{ href: '/banking', label: t('overview.title') }}
          title={t('rules.title')}
          description={t('rules.description')}
          actions={
            <div className="flex items-center gap-2">
              <RunRulesButton accounts={reconAccountOpts} />
              <NewRuleButton />
            </div>
          }
        />
      }
    >
      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput placeholder={t('rules.search')} />
          <FilterChips basePath="/banking/rules" currentParams={sp} paramKey="active" label={tCommon('labels.status')} options={activeOptions} />
        </div>
        {total === 0 && !params.q && !active ? (
          <EmptyState title={t('rules.emptyTitle')} description={t('rules.emptyDescription')} action={<NewRuleButton />} />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <SortTh basePath="/banking/rules" currentParams={sp} column="priority" sort={params.sort} dir={params.dir} align="right">{t('rules.priority')}</SortTh>
                  <SortTh basePath="/banking/rules" currentParams={sp} column="name" sort={params.sort} dir={params.dir}>{tCommon('labels.name')}</SortTh>
                  <TableHead>{t('rules.whenLabel')}</TableHead>
                  <TableHead>{t('rules.thenLabel')}</TableHead>
                  <TableHead>{tCommon('labels.status')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.rows.map((r: any) => {
                  const c = r.criteria ?? {}
                  const o = r.outcome ?? {}
                  const whenParts: string[] = []
                  if (c.descriptionContains) whenParts.push(t('rules.summary.contains', { text: c.descriptionContains }))
                  if (c.amountSign === 'in') whenParts.push(t('rules.summary.moneyIn'))
                  if (c.amountSign === 'out') whenParts.push(t('rules.summary.moneyOut'))
                  if (typeof c.minAmount === 'number' || typeof c.maxAmount === 'number') {
                    whenParts.push(t('rules.summary.amountRange', { min: c.minAmount ?? '0', max: c.maxAmount ?? '∞' }))
                  }
                  const offsetName = accountOpts.find((a) => a.id === o.accountId)?.label
                  const then = o.action === 'exclude'
                    ? t('rules.summary.exclude')
                    : t('rules.summary.categorize', { account: offsetName ?? '—' })
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="text-right tabular-nums text-slate-500 dark:text-slate-400">{r.priority}</TableCell>
                      <TableCell className="font-medium">
                        <Link href={`/banking/rules?rule=${r.id}` as any} className="text-teal-700 hover:underline dark:text-teal-300">{r.name}</Link>
                      </TableCell>
                      <TableCell className="max-w-xs truncate text-slate-600 dark:text-slate-300">
                        {whenParts.length ? whenParts.join(' · ') : t('rules.summary.anyLine')}
                      </TableCell>
                      <TableCell className="max-w-xs truncate text-slate-600 dark:text-slate-300">{then}</TableCell>
                      <TableCell>
                        {r.is_active ? (
                          <Badge variant="success">{tCommon('labels.active')}</Badge>
                        ) : (
                          <Badge variant="secondary">{t('rules.inactive')}</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
            <Pagination basePath="/banking/rules" currentParams={sp} total={total} page={params.page} perPage={params.perPage} />
          </>
        )}
      </section>

      {drawerOpen ? <RuleDrawer rule={openRule} accounts={accountOpts} /> : null}
    </ListPageLayout>
  )
}

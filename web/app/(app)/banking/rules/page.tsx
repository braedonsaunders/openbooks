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
import { summarizeGroup, type FieldDef } from '../../../../lib/conditions'
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
  const fromLine = pickString(sp.fromLine)

  const [rows, count, activeCounts, offsetAccounts, reconAccounts, departments, locations, classes, taxCodes, parties, open, seedLine] =
    (await Promise.all([
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
      db.execute(sql`select id, code, name from departments where org_id = ${authz.user.orgId} and is_active order by name limit 1000`),
      db.execute(sql`select id, code, name from locations where org_id = ${authz.user.orgId} and is_active order by name limit 1000`),
      db.execute(sql`select id, code, name from classes where org_id = ${authz.user.orgId} and is_active order by name limit 1000`),
      db.execute(sql`select id, code, name from tax_codes where org_id = ${authz.user.orgId} and is_active order by code limit 500`),
      db.execute(sql`select id, display_name from parties where org_id = ${authz.user.orgId} and is_active order by display_name limit 2000`),
      openId && openId !== 'new' && isUuid(openId)
        ? db.execute(sql`
            select id, name, criteria, outcome, priority, is_active
              from bank_match_rules where id = ${openId} and org_id = ${authz.user.orgId}
          `)
        : Promise.resolve({ rows: [] }),
      fromLine && isUuid(fromLine)
        ? db.execute(sql`
            select l.description, l.amount from bank_statement_lines l
             where l.id = ${fromLine} and l.org_id = ${authz.user.orgId} limit 1
          `)
        : Promise.resolve({ rows: [] }),
    ])) as unknown as { rows: any[] }[]

  const total = Number(count.rows[0].n)
  const activeMap = new Map(activeCounts.rows.map((r: any) => [r.is_active, Number(r.n)]))
  const activeOptions = [
    { value: 'true', label: tCommon('labels.active'), count: activeMap.get(true) ?? 0 },
    { value: 'false', label: t('rules.inactive'), count: activeMap.get(false) ?? 0 },
  ].filter((o) => o.count > 0)

  const accountOpts = offsetAccounts.rows.map((a: any) => ({ value: a.id, label: [a.number, a.name].filter(Boolean).join(' · ') }))
  const reconAccountOpts = reconAccounts.rows.map((a: any) => ({ id: a.id, label: [a.number, a.name].filter(Boolean).join(' · ') }))
  const dimOpts = (rowsIn: any[]) => rowsIn.map((d: any) => ({ value: d.id, label: [d.code, d.name].filter(Boolean).join(' · ') }))
  const departmentOpts = dimOpts(departments.rows)
  const locationOpts = dimOpts(locations.rows)
  const classOpts = dimOpts(classes.rows)
  const taxOpts = taxCodes.rows.map((x: any) => ({ value: x.id, label: [x.code, x.name].filter(Boolean).join(' · ') }))
  const partyOpts = parties.rows.map((p: any) => ({ value: p.id, label: p.display_name }))
  const accountLabel = new Map(accountOpts.map((a) => [a.value, a.label]))

  const openRule = openId === 'new' ? null : (open.rows[0] ?? null)
  const drawerOpen = openId === 'new' || !!open.rows[0]
  const seed = seedLine.rows[0] ? { description: seedLine.rows[0].description, amount: seedLine.rows[0].amount } : null

  // v2-aware summary catalog for list rows.
  const summaryCatalog: FieldDef[] = [
    { key: 'description', label: t('rules.fields.description'), kind: 'text' },
    { key: 'payee', label: t('rules.fields.payee'), kind: 'text' },
    { key: 'anyText', label: t('rules.fields.anyText'), kind: 'text' },
    { key: 'reference', label: t('rules.fields.reference'), kind: 'text' },
    { key: 'amount', label: t('rules.fields.amount'), kind: 'number' },
    { key: 'flow', label: t('rules.fields.flow'), kind: 'flow', options: [{ value: 'in', label: t('rules.signIn') }, { value: 'out', label: t('rules.signOut') }] },
    { key: 'date', label: t('rules.fields.date'), kind: 'date' },
  ]
  const opLabels = Object.fromEntries(
    ['contains', 'notContains', 'equals', 'startsWith', 'endsWith', 'isBlank', 'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'is', 'on', 'before', 'after', 'withinDays'].map(
      (k) => [k, t(`rules.ops.${k}`)],
    ),
  )

  function whenSummary(criteria: any): string {
    if (criteria?.version === 2 && criteria.match) {
      const s = summarizeGroup(criteria.match, summaryCatalog, { and: t('rules.summary.and'), or: t('rules.summary.or'), operatorLabels: opLabels })
      return s || t('rules.summary.anyLine')
    }
    // legacy
    const parts: string[] = []
    if (criteria?.descriptionContains) parts.push(t('rules.summary.contains', { text: criteria.descriptionContains }))
    if (criteria?.amountSign === 'in') parts.push(t('rules.summary.moneyIn'))
    if (criteria?.amountSign === 'out') parts.push(t('rules.summary.moneyOut'))
    if (typeof criteria?.minAmount === 'number' || typeof criteria?.maxAmount === 'number') {
      parts.push(t('rules.summary.amountRange', { min: criteria?.minAmount ?? '0', max: criteria?.maxAmount ?? '∞' }))
    }
    return parts.length ? parts.join(' · ') : t('rules.summary.anyLine')
  }
  function thenSummary(outcome: any): { text: string; mode?: 'auto' | 'suggest' } {
    if (outcome?.action === 'exclude') return { text: t('rules.summary.exclude') }
    if (outcome?.action === 'categorize' && outcome?.version === 2) {
      const first = accountLabel.get(outcome.lines?.[0]?.accountId) ?? '—'
      const extra = (outcome.lines?.length ?? 1) - 1
      const label = extra > 0 ? t('rules.summary.categorizeSplit', { account: first, count: extra }) : t('rules.summary.categorize', { account: first })
      return { text: label, mode: outcome.mode }
    }
    if (outcome?.action === 'categorize') return { text: t('rules.summary.categorize', { account: accountLabel.get(outcome.accountId) ?? '—' }) }
    return { text: '—' }
  }

  return (
    <ListPageLayout
      header={
        <PageHeader
          back={{ href: '/banking', label: t('home.title') }}
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
                  const then = thenSummary(r.outcome)
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="text-right tabular-nums text-slate-500 dark:text-slate-400">{r.priority}</TableCell>
                      <TableCell className="font-medium">
                        <Link href={`/banking/rules?rule=${r.id}` as any} className="text-teal-700 hover:underline dark:text-teal-300">{r.name}</Link>
                      </TableCell>
                      <TableCell className="max-w-xs truncate text-slate-600 dark:text-slate-300">{whenSummary(r.criteria)}</TableCell>
                      <TableCell className="max-w-xs truncate text-slate-600 dark:text-slate-300">
                        <span className="inline-flex items-center gap-1.5">
                          {then.text}
                          {then.mode === 'auto' ? <Badge variant="secondary">{t('rules.modeAuto')}</Badge> : then.mode === 'suggest' ? <Badge variant="secondary">{t('rules.modeSuggest')}</Badge> : null}
                        </span>
                      </TableCell>
                      <TableCell>
                        {r.is_active ? <Badge variant="success">{tCommon('labels.active')}</Badge> : <Badge variant="secondary">{t('rules.inactive')}</Badge>}
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

      {drawerOpen ? (
        <RuleDrawer
          rule={openRule}
          accounts={accountOpts}
          reconAccounts={reconAccountOpts}
          departments={departmentOpts}
          locations={locationOpts}
          classes={classOpts}
          taxCodes={taxOpts}
          parties={partyOpts}
          seedFromLine={seed}
        />
      ) : null}
    </ListPageLayout>
  )
}

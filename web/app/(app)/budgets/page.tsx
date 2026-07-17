import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { Badge, EmptyState, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { SearchInput } from '../../../components/search-input'
import { FilterChips } from '../../../components/filter-bar'
import { Pagination } from '../../../components/pagination'
import { SortTh } from '../../../components/sortable-th'
import { can, requirePermission } from '../../../lib/authz'
import { dateTime, money } from '../../../lib/format'
import { parseListParams, pickString } from '../../../lib/list-params'
import { BUDGET_KINDS, BUDGET_STATUSES, loadBudgetBooksAndYears } from '../../../lib/budgets'
import { NewBudgetButton } from './NewBudgetButton'

export const dynamic = 'force-dynamic'

const SORTS = {
  name: sql`bs.name`,
  year: sql`bs.fiscal_year`,
  updated: sql`bs.updated_at`,
  total: sql`total_amount`,
} as const

export default async function BudgetsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const t = await getTranslations('budgets')
  const authz = await requirePermission('budgets.read')
  const orgId = authz.user.orgId
  const canManage = can(authz, 'budgets.manage')
  const sp = await searchParams
  const params = parseListParams(sp, { sort: 'updated', dir: 'desc', perPage: 25, allowedSorts: ['name', 'year', 'updated', 'total'] as const })
  const rawStatus = pickString(sp.status)
  const status = BUDGET_STATUSES.includes(rawStatus as any) ? rawStatus : undefined
  const rawKind = pickString(sp.kind)
  const kind = BUDGET_KINDS.includes(rawKind as any) ? rawKind : undefined
  const year = /^\d{4}$/.test(pickString(sp.year) ?? '') ? Number(pickString(sp.year)) : undefined
  const bookId = pickString(sp.book)
  const { books, years } = await loadBudgetBooksAndYears(orgId)
  const where = sql`bs.org_id = ${orgId}
    ${params.q ? sql`and (bs.name ilike ${`%${params.q}%`} or coalesce(bs.description, '') ilike ${`%${params.q}%`})` : sql``}
    ${status ? sql`and bs.status = ${status}` : sql``}
    ${kind ? sql`and bs.kind = ${kind}` : sql``}
    ${year ? sql`and bs.fiscal_year = ${year}` : sql``}
    ${bookId ? sql`and bs.book_id = ${bookId}` : sql``}`
  const [rows, count, sources] = await Promise.all([
    db.execute(sql`
      select bs.id, bs.name, bs.fiscal_year, bs.kind, bs.status, bs.updated_at,
             b.name as book_name, coalesce(sum(bl.amount), 0)::text as total_amount
        from budget_scenarios bs
        join accounting_books b on b.id = bs.book_id and b.org_id = bs.org_id
        left join budget_lines bl on bl.scenario_id = bs.id and bl.org_id = bs.org_id
       where ${where}
       group by bs.id, b.name
       order by ${SORTS[params.sort]} ${params.dir === 'asc' ? sql`asc` : sql`desc`} nulls last
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
    `) as Promise<{ rows: Record<string, any>[] }>,
    db.execute(sql`select count(*) as n from budget_scenarios bs where ${where}`) as Promise<{ rows: { n: string }[] }>,
    canManage ? db.execute(sql`
      select id, name, fiscal_year from budget_scenarios
       where org_id = ${orgId} and status <> 'archived' order by updated_at desc limit 50
    `) as Promise<{ rows: { id: string; name: string; fiscal_year: number }[] }> : Promise.resolve({ rows: [] }),
  ])
  const total = Number(count.rows[0]?.n ?? 0)
  const statusVariant = (value: string) => value === 'approved' ? 'success' : value === 'pending_approval' ? 'warning' : value === 'archived' ? 'outline' : 'secondary'

  return (
    <ListPageLayout header={<>
      <PageHeader title={t('list.title')} description={t('list.description')} actions={canManage ? <NewBudgetButton books={books} years={years} sources={sources.rows} /> : undefined} />
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput placeholder={t('list.search')} />
        <FilterChips basePath="/budgets" currentParams={sp} paramKey="status" label={t('list.statusFilter')} options={BUDGET_STATUSES.map((value) => ({ value, label: t(`status.${value}`) }))} />
        <FilterChips basePath="/budgets" currentParams={sp} paramKey="kind" label={t('list.kindFilter')} options={BUDGET_KINDS.map((value) => ({ value, label: t(`kind.${value}`) }))} />
        <FilterChips basePath="/budgets" currentParams={sp} paramKey="year" label={t('list.yearFilter')} options={years.map((value) => ({ value: String(value), label: String(value) }))} />
        <FilterChips basePath="/budgets" currentParams={sp} paramKey="book" label={t('list.bookFilter')} options={books.map((book) => ({ value: book.id, label: book.name }))} />
      </div>
    </>}>
      {total === 0 ? <EmptyState title={t('list.emptyTitle')} description={t('list.emptyDescription')} action={canManage ? <NewBudgetButton books={books} years={years} sources={sources.rows} /> : undefined} /> : <>
        <Table>
          <TableHeader><TableRow>
            <SortTh basePath="/budgets" currentParams={sp} column="name" sort={params.sort} dir={params.dir}>{t('columns.name')}</SortTh>
            <TableHead>{t('columns.book')}</TableHead>
            <SortTh basePath="/budgets" currentParams={sp} column="year" sort={params.sort} dir={params.dir}>{t('columns.fiscalYear')}</SortTh>
            <TableHead>{t('columns.kind')}</TableHead>
            <TableHead>{t('columns.status')}</TableHead>
            <SortTh basePath="/budgets" currentParams={sp} column="total" sort={params.sort} dir={params.dir} align="right">{t('columns.total')}</SortTh>
            <SortTh basePath="/budgets" currentParams={sp} column="updated" sort={params.sort} dir={params.dir}>{t('columns.updated')}</SortTh>
          </TableRow></TableHeader>
          <TableBody>{rows.rows.map((row) => <TableRow key={row.id}>
            <TableCell className="font-semibold"><Link href={`/budgets/${row.id}`} className="text-teal-700 hover:underline dark:text-teal-300">{row.name}</Link></TableCell>
            <TableCell>{row.book_name}</TableCell>
            <TableCell className="tabular-nums">{row.fiscal_year}</TableCell>
            <TableCell><Badge variant="outline">{t(`kind.${row.kind}`)}</Badge></TableCell>
            <TableCell><Badge variant={statusVariant(row.status)}>{t(`status.${row.status}`)}</Badge></TableCell>
            <TableCell className="text-right tabular-nums">{money(row.total_amount)}</TableCell>
            <TableCell className="text-slate-500 dark:text-slate-400">{dateTime(row.updated_at)}</TableCell>
          </TableRow>)}</TableBody>
        </Table>
        <Pagination basePath="/budgets" currentParams={sp} total={total} page={params.page} perPage={params.perPage} />
      </>}
    </ListPageLayout>
  )
}

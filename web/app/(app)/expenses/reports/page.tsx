import { getMoneyFormatter } from '@/lib/money-server'
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
import { buildListDrawerHref, parseListParams, pickString } from '../../../../lib/list-params'
import { can, requirePermission } from '../../../../lib/authz'
import { ExpenseActions } from '../ExpenseActions'
import { ExpenseDrawer } from '../ExpenseDrawer'
import { NewExpenseButton } from '../NewExpenseButton'
import { loadExpenseReport } from '../../../../lib/expenses'
import { loadFieldDefs } from '../../../../lib/custom-fields'
import { customSegmentOptions } from '../../../../lib/segments'
import { RelatedPartyLink } from '../../../../components/related-party-link'
import { resolveFormLayout } from '../../../../lib/customization/resolve'
import { taxCodeOptions, taxGroupOptions } from '../../../../lib/documents'

export const dynamic = 'force-dynamic'

const STATUS_VARIANT: Record<string, 'success' | 'secondary' | 'warning' | 'outline'> = {
  posted: 'success',
  approved: 'success',
  pending_approval: 'warning',
  draft: 'secondary',
  voided: 'outline',
}

// Built-in expense_report statuses → common.status.* message keys. Unknown
// (custom) statuses render verbatim with underscores humanized.
const STATUS_LABEL_KEYS: Record<string, string> = {
  draft: 'draft',
  pending_approval: 'pendingApproval',
  approved: 'approved',
  posted: 'posted',
  voided: 'voided',
}

const SORT_COLUMNS = {
  date: sql`d.document_date`,
  number: sql`d.document_number`,
  employee: sql`p.display_name`,
  total: sql`d.total`,
  status: sql`d.status`,
} as const

export default async function Expenses({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { money } = await getMoneyFormatter()
  const t = await getTranslations('expenses')
  const tCommon = await getTranslations('common')
  const statusLabel = (s: string) => {
    const key = STATUS_LABEL_KEYS[s]
    return key ? tCommon(`status.${key}`) : String(s).replace('_', ' ')
  }

  const authz = await requirePermission('expenses.read')
  const canSubmit = can(authz, 'expenses.create')
  const canPost = can(authz, 'ap.post')

  const sp = await searchParams
  const expenseId = typeof sp.expense === 'string' ? sp.expense : undefined
  const params = parseListParams(sp, {
    sort: 'date',
    dir: 'desc',
    perPage: 25,
    allowedSorts: ['date', 'number', 'employee', 'total', 'status'] as const,
  })
  const status = pickString(sp.status)
  const employee = pickString(sp.employee)

  const where = sql`d.kind = 'expense_report' and d.org_id = ${authz.user.orgId}
    ${status ? sql` and d.status = ${status}` : sql``}
    ${employee ? sql` and d.party_id = ${employee}` : sql``}
    ${params.q ? sql` and (d.document_number ilike ${'%' + params.q + '%'} or p.display_name ilike ${'%' + params.q + '%'} or d.memo ilike ${'%' + params.q + '%'})` : sql``}`

  const [reports, statusCounts, employeeCounts] = await Promise.all([
    db.execute(sql`
      select d.id, d.party_id, d.document_number, d.document_date, d.status, d.total, d.memo,
             p.display_name as employee, e.id as entry_id
        from documents d
        left join parties p on p.id = d.party_id
        left join journal_entries e on e.id = d.posted_entry_id
       where ${where}
       order by ${SORT_COLUMNS[params.sort]} ${params.dir === 'asc' ? sql`asc` : sql`desc`} nulls last
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
    `) as any,
    db.execute(sql`
      select d.status, count(*) as n from documents d
       where d.kind = 'expense_report'
         and d.org_id = ${authz.user.orgId}
       group by d.status
    `) as any,
    db.execute(sql`
      select p.id, p.display_name, count(*) as n
        from documents d
        join parties p on p.id = d.party_id
       where d.kind = 'expense_report'
         and d.org_id = ${authz.user.orgId}
       group by p.id, p.display_name
       order by p.display_name
    `) as any,
  ])
  const total = statusCounts.rows.reduce((a: number, r: any) => a + Number(r.n), 0)
  const filteredTotal = status || employee || params.q
    ? Number(((await db.execute(sql`
        select count(*) as n from documents d
          left join parties p on p.id = d.party_id
         where ${where}`)) as any).rows[0].n)
    : total

  const [openReport, pickers] = await Promise.all([
    expenseId ? loadExpenseReport(expenseId, authz.user.orgId) : null,
    expenseId
      ? Promise.all([
          db.execute(sql`
            select p.id, p.display_name from parties p
             where p.is_active
               and p.org_id = ${authz.user.orgId}
               and (p.custom->>'nsKind' = 'employee'
                    or exists (select 1 from employee_roles er where er.party_id = p.id))
             order by p.display_name limit 2000`) as any,
          db.execute(sql`select id, number, name from accounts where type in ('expense','expense_other','cogs') and is_active and not is_summary and org_id = ${authz.user.orgId} order by number nulls last`) as any,
          taxCodeOptions(authz.user.orgId),
          taxGroupOptions(authz.user.orgId),
          db.execute(sql`select id, name from departments where is_active and org_id = ${authz.user.orgId} order by name`) as any,
          db.execute(sql`select id, name from projects where is_active and org_id = ${authz.user.orgId} order by name limit 2000`) as any,
          loadFieldDefs('documents', 'expense_report'),
          loadFieldDefs('document_lines', 'expense_report'),
          customSegmentOptions(authz.user.orgId),
        ])
      : null,
  ])
  const resolvedForm = openReport && pickers
    ? await resolveFormLayout({
        orgId: authz.user.orgId,
        userId: authz.user.id,
        recordType: 'expense_report',
        userRoles: [authz.user.role],
        headerDefs: pickers[6] as any,
        lineDefs: pickers[7] as any,
        explicitLayoutId: pickString(sp.form),
      })
    : null

  const statusOptions = statusCounts.rows.map((r: any) => ({
    value: r.status,
    label: statusLabel(String(r.status)),
    count: Number(r.n),
  }))
  const employeeOptions = employeeCounts.rows.map((r: any) => ({
    value: r.id,
    label: r.display_name,
    count: Number(r.n),
  }))

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title={t('list.title')}
            description={t('list.description')}
            actions={canSubmit ? <NewExpenseButton /> : undefined}
          />
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput placeholder={t('list.searchPlaceholder')} />
            <FilterChips basePath="/expenses/reports" currentParams={sp} paramKey="status" label={tCommon('labels.status')} options={statusOptions} />
            <FilterChips basePath="/expenses/reports" currentParams={sp} paramKey="employee" label={tCommon('labels.employee')} options={employeeOptions} />
          </div>
        </>
      }
    >
      {total === 0 ? (
        <EmptyState
          title={t('list.emptyTitle')}
          description={t('list.emptyDescription')}
          action={canSubmit ? <NewExpenseButton /> : undefined}
        />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <SortTh basePath="/expenses/reports" currentParams={sp} column="number" sort={params.sort} dir={params.dir}>{t('list.columns.report')}</SortTh>
                <SortTh basePath="/expenses/reports" currentParams={sp} column="employee" sort={params.sort} dir={params.dir}>{tCommon('labels.employee')}</SortTh>
                <SortTh basePath="/expenses/reports" currentParams={sp} column="date" sort={params.sort} dir={params.dir}>{tCommon('labels.date')}</SortTh>
                <TableHead>{tCommon('labels.memo')}</TableHead>
                <SortTh basePath="/expenses/reports" currentParams={sp} column="total" sort={params.sort} dir={params.dir} align="right">{tCommon('labels.total')}</SortTh>
                <SortTh basePath="/expenses/reports" currentParams={sp} column="status" sort={params.sort} dir={params.dir}>{tCommon('labels.status')}</SortTh>
                <TableHead className="w-16 px-2 text-center">{tCommon('labels.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {reports.rows.map((r: any) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-[13px] font-semibold">
                    <Link href={buildListDrawerHref('/expenses/reports', sp, 'expense', String(r.id)) as any} className="text-teal-700 hover:underline dark:text-teal-300">
                      {r.document_number}
                    </Link>
                  </TableCell>
                  <TableCell>
                    {r.party_id && r.employee ? (
                      <RelatedPartyLink partyId={String(r.party_id)} role="employee" className="text-teal-700 hover:underline dark:text-teal-300">
                        {r.employee}
                      </RelatedPartyLink>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </TableCell>
                  <TableCell>{r.document_date}</TableCell>
                  <TableCell className="text-slate-500 dark:text-slate-400">{r.memo}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(r.total)}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[r.status] ?? 'secondary'}>
                      {statusLabel(String(r.status))}
                    </Badge>
                  </TableCell>
                  <TableCell className="w-11">
                    <ExpenseActions id={r.id} status={r.status} canSubmit={canSubmit} canPost={canPost} openHref={`/expenses/reports?expense=${r.id}`} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="mt-3">
            <Pagination basePath="/expenses/reports" currentParams={sp} total={filteredTotal} page={params.page} perPage={params.perPage} />
          </div>
        </>
      )}
      {openReport && pickers ? (
        <ExpenseDrawer
          report={openReport as any}
          employees={pickers[0].rows}
          accounts={pickers[1].rows}
          taxCodes={pickers[2] as any}
          taxGroups={pickers[3] as any}
          departments={pickers[4].rows}
          projects={pickers[5].rows}
          headerDefs={pickers[6] as any}
          lineDefs={pickers[7] as any}
          segments={pickers[8] as any}
          canSubmit={canSubmit}
          canPost={canPost}
          layout={resolvedForm?.layout}
        />
      ) : null}
    </ListPageLayout>
  )
}

import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/db.ts'
import { Badge, EmptyState, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { ScrollText } from 'lucide-react'
import { ListPageLayout } from '../../../../components/page-layout'
import { SearchInput } from '../../../../components/search-input'
import { FilterChips } from '../../../../components/filter-bar'
import { DateRangeFilter } from '../../../../components/date-range-filter'
import { Pagination } from '../../../../components/pagination'
import { parseListParams, pickString } from '../../../../lib/list-params'
import { requirePermission } from '../../../../lib/authz'
import { dateTime } from '../../../../lib/format'

export const dynamic = 'force-dynamic'

// Raw record-type tokens (table names or document kinds like "customer_invoice")
// → friendly labels: "Customer Invoice", "Journal Entry", "Budget Scenarios".
const humanize = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

const ACTION_VARIANT: Record<string, 'success' | 'secondary' | 'warning' | 'destructive' | 'outline'> = {
  insert: 'success',
  update: 'secondary',
  delete: 'destructive',
  post: 'success',
  void: 'warning',
  approve: 'success',
  reject: 'destructive',
}

// Known audit actions with translated labels (admin.audit.actions.*); anything
// else in the log renders verbatim as the stored action code.
const KNOWN_ACTIONS = new Set(['insert', 'update', 'delete', 'post', 'void', 'approve', 'reject'])

export default async function Audit({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requirePermission('admin.audit.read')
  const t = await getTranslations('admin.audit')
  const tHub = await getTranslations('admin.hub')
  const sp = await searchParams
  const params = parseListParams(sp, { sort: 'at', allowedSorts: ['at'] as const, perPage: 50 })
  const action = pickString(sp.action)
  const rtype = pickString(sp.rtype)
  const actor = pickString(sp.actor)
  const from = pickString(sp.from)
  const to = pickString(sp.to)

  // Effective record type: the raw table for most rows, but the document's KIND
  // (customer_invoice, vendor_bill, journal_entry, …) for the shared `documents`
  // table so the filter splits it into its transaction types. Deleted documents
  // (no kind) fall back to "documents".
  const rtypeExpr = sql`case when a.table_name = 'documents' then coalesce(d.kind, 'documents') else a.table_name end`
  const auditFrom = sql`
    from audit_log a
    left join users u on u.id = a.actor_id
    left join documents d on a.table_name = 'documents' and d.id = a.row_id`

  const where = sql`true
    ${action ? sql` and a.action = ${action}` : sql``}
    ${rtype ? sql` and (${rtypeExpr}) = ${rtype}` : sql``}
    ${actor ? (actor === 'system' ? sql` and a.actor_id is null` : sql` and a.actor_id = ${actor}`) : sql``}
    ${from ? sql` and a.at >= ${from}::date` : sql``}
    ${to ? sql` and a.at < (${to}::date + interval '1 day')` : sql``}
    ${params.q ? sql` and ((${rtypeExpr}) ilike ${'%' + params.q + '%'} or u.name ilike ${'%' + params.q + '%'} or a.row_id::text = ${params.q})` : sql``}`

  const [rows, totalRow, actions, rtypes, users] = await Promise.all([
    db.execute(sql`
      select a.*, u.name as actor_name, (${rtypeExpr}) as rtype
        ${auditFrom}
       where ${where}
       order by a.at desc
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
    `) as any,
    db.execute(sql`select count(*) as n ${auditFrom} where ${where}`) as any,
    db.execute(sql`select action, count(*) as n from audit_log group by 1 order by 2 desc`) as any,
    db.execute(sql`select (${rtypeExpr}) as rtype, count(*) as n ${auditFrom} group by 1 order by 2 desc limit 60`) as any,
    db.execute(sql`
      select a.actor_id, u.name, count(*) as n
        from audit_log a left join users u on u.id = a.actor_id
       group by 1, 2 order by 3 desc limit 50
    `) as any,
  ])
  const total = Number(totalRow.rows[0].n)
  const actionLabel = (a: string) => (KNOWN_ACTIONS.has(a) ? t(`actions.${a}`) : a)

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            back={{ href: '/admin', label: tHub('title') }}
            title={t('title')}
            description={t('description')}
          />
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput placeholder={t('searchPlaceholder')} />
            <FilterChips
              basePath="/admin/audit"
              currentParams={sp}
              paramKey="rtype"
              label={t('recordTypeFilter')}
              options={rtypes.rows.map((r: any) => ({ value: r.rtype, label: humanize(r.rtype), count: Number(r.n) }))}
            />
            <FilterChips
              basePath="/admin/audit"
              currentParams={sp}
              paramKey="actor"
              label={t('userFilter')}
              options={users.rows.map((r: any) => ({
                value: r.actor_id ?? 'system',
                label: r.name ?? t('systemActor'),
                count: Number(r.n),
              }))}
            />
            <FilterChips
              basePath="/admin/audit"
              currentParams={sp}
              paramKey="action"
              label={t('actionFilter')}
              options={actions.rows.map((r: any) => ({ value: r.action, label: actionLabel(r.action), count: Number(r.n) }))}
            />
            <DateRangeFilter fromLabel={t('dateFrom')} toLabel={t('dateTo')} clearLabel={t('clearDates')} />
          </div>
        </>
      }
    >
      {total === 0 ? (
        <EmptyState
          icon={<ScrollText />}
          title={t('empty.title')}
          description={t('empty.description')}
        />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('table.when')}</TableHead>
                <TableHead>{t('table.actor')}</TableHead>
                <TableHead>{t('table.action')}</TableHead>
                <TableHead>{t('table.tableName')}</TableHead>
                <TableHead>{t('table.row')}</TableHead>
                <TableHead>{t('table.changes')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.rows.map((r: any) => (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-nowrap">{dateTime(r.at)}</TableCell>
                  <TableCell>{r.actor_name ?? <span className="text-slate-400">{t('systemActor')}</span>}</TableCell>
                  <TableCell>
                    <Badge variant={ACTION_VARIANT[r.action] ?? 'secondary'}>{actionLabel(r.action)}</Badge>
                  </TableCell>
                  <TableCell>{humanize(r.rtype)}</TableCell>
                  <TableCell className="font-mono text-xs text-slate-500">{String(r.row_id).slice(0, 8)}…</TableCell>
                  <TableCell className="max-w-md">
                    <pre className="overflow-x-auto font-mono text-[11px] text-slate-500 dark:text-slate-400">
                      {JSON.stringify(r.changes)}
                    </pre>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="mt-3">
            <Pagination basePath="/admin/audit" currentParams={sp} total={total} page={params.page} perPage={params.perPage} />
          </div>
        </>
      )}
    </ListPageLayout>
  )
}

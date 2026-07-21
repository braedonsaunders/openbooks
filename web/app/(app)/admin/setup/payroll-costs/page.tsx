import Link from 'next/link'
import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { Badge, Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { db } from '@openbooks/engine/src/db.ts'
import { SearchInput } from '../../../../../components/search-input'
import { FilterChips } from '../../../../../components/filter-bar'
import { Pagination } from '../../../../../components/pagination'
import { requirePermission } from '../../../../../lib/authz'
import { parseListParams } from '../../../../../lib/list-params'
import { PayrollBatchActions } from './PayrollBatchActions'

export const dynamic = 'force-dynamic'

export default async function PayrollCostsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { user } = await requirePermission('admin.setup.manage')
  const t = await getTranslations('admin.setup.payrollOperations')
  const sp = await searchParams
  const list = parseListParams(sp, { sort: 'default', allowedSorts: ['default'] as const, perPage: 25 })
  const status = typeof sp.status === 'string' && ['draft', 'validated', 'reconciled', 'posted'].includes(sp.status) ? sp.status : ''
  const filter = sql`where b.org_id = ${user.orgId}
    ${list.q ? sql`and (b.code ilike ${`%${list.q}%`} or sub.name ilike ${`%${list.q}%`} or src.name ilike ${`%${list.q}%`} or b.external_batch_id ilike ${`%${list.q}%`})` : sql``}
    ${status ? sql`and b.status = ${status}` : sql``}`
  const [rows, count, templates] = await Promise.all([
    db.execute(sql`
      select b.*, sub.name as subsidiary_name, src.name as source_name, src.accounting_mode,
             d.document_number as source_journal_number, count(l.id)::int as line_count
        from payroll_cost_batches b join subsidiaries sub on sub.id = b.subsidiary_id
        join external_payroll_sources src on src.id = b.source_id
        left join documents d on d.id = b.source_journal_document_id
        left join payroll_cost_lines l on l.batch_id = b.id
        ${filter} group by b.id, sub.name, src.name, src.accounting_mode, d.document_number order by b.period_end desc, b.code
        limit ${list.perPage} offset ${(list.page - 1) * list.perPage}`) as any,
    db.execute(sql`select count(*)::int as n from payroll_cost_batches b join subsidiaries sub on sub.id = b.subsidiary_id join external_payroll_sources src on src.id = b.source_id ${filter}`) as any,
    db.execute(sql`
      select id, name from external_payroll_import_templates
       where org_id = ${user.orgId} and is_active order by name limit 20`) as any,
  ])
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="text-lg font-semibold">{t('title')}</h2><p className="text-sm text-slate-500 dark:text-slate-400">{t('description')}</p></div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" asChild><Link href="/data/import?resource=journal-entries">{t('importJournal')}</Link></Button>
          <Button variant="outline" size="sm" asChild><Link href="/data/import?resource=payroll-cost-lines">{t('importCosts')}</Link></Button>
          <Button size="sm" asChild><Link href="/admin/setup/payroll-cost-batches?row=new">{t('newBatch')}</Link></Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" asChild><Link href="/admin/setup/external-payroll-sources">{t('manageSources')}</Link></Button>
        <Button variant="ghost" size="sm" asChild><Link href="/admin/setup/external-payroll-import-templates">{t('manageTemplates')}</Link></Button>
        {templates.rows.map((template: any) => <Button key={template.id} variant="ghost" size="sm" asChild><Link href={`/data/import?resource=payroll-cost-lines&template=${template.id}`}>{t('useTemplate', { name: template.name })}</Link></Button>)}
        <Button variant="ghost" size="sm" asChild><a href="/api/admin/setup/payroll-costs?template=generic" download>{t('examples.generic')}</a></Button>
        <Button variant="ghost" size="sm" asChild><a href="/api/admin/setup/payroll-costs?template=construction_union" download>{t('examples.constructionUnion')}</a></Button>
        <Button variant="ghost" size="sm" asChild><a href="/api/admin/setup/payroll-costs?template=professional_services" download>{t('examples.professionalServices')}</a></Button>
        <Button variant="ghost" size="sm" asChild><Link href="/docs/labor-rates">{t('documentation')}</Link></Button>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SearchInput placeholder={t('search')} />
        <FilterChips basePath="/admin/setup/payroll-costs" currentParams={sp} paramKey="status" label={t('statusFilter')} options={['draft', 'validated', 'reconciled', 'posted'].map((value) => ({ value, label: t(`statuses.${value}`) }))} />
      </div>
      <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
        <Table><TableHeader><TableRow><TableHead>{t('columns.batch')}</TableHead><TableHead>{t('columns.source')}</TableHead><TableHead>{t('columns.subsidiary')}</TableHead><TableHead>{t('columns.period')}</TableHead><TableHead>{t('columns.lines')}</TableHead><TableHead>{t('columns.journal')}</TableHead><TableHead className="text-right">{t('columns.actual')}</TableHead><TableHead className="text-right">{t('columns.variance')}</TableHead><TableHead>{t('columns.status')}</TableHead><TableHead>{t('columns.action')}</TableHead></TableRow></TableHeader>
          <TableBody>{rows.rows.map((row: any) => <TableRow key={row.id}><TableCell><Link className="font-medium text-teal-700 hover:underline dark:text-teal-300" href={`/admin/setup/payroll-cost-batches?row=${row.id}`}>{row.code}</Link><div className="text-xs text-slate-500">{row.external_batch_id}</div>{row.exception_count > 0 ? <div className="max-w-56 truncate text-xs text-red-600 dark:text-red-400" title={(row.validation_errors ?? []).join('\n')}>{t('exceptionCount', { count: row.exception_count })}</div> : null}</TableCell><TableCell>{row.source_name}</TableCell><TableCell>{row.subsidiary_name}</TableCell><TableCell>{row.period_start} – {row.period_end}</TableCell><TableCell>{row.line_count}</TableCell><TableCell>{row.source_journal_number ?? t('notLinked')}</TableCell><TableCell className="text-right tabular-nums">{row.actual_total_base}</TableCell><TableCell className="text-right tabular-nums">{row.variance_total}</TableCell><TableCell><Badge variant={row.status === 'posted' ? 'success' : row.status === 'reconciled' || row.status === 'validated' ? 'warning' : 'outline'}>{t(`statuses.${row.status}`)}</Badge></TableCell><TableCell><PayrollBatchActions batchId={row.id} status={row.status} accountingMode={row.accounting_mode} /></TableCell></TableRow>)}</TableBody>
        </Table>
      </div>
      <Pagination basePath="/admin/setup/payroll-costs" currentParams={sp} page={list.page} perPage={list.perPage} total={Number(count.rows[0]?.n ?? 0)} />
    </div>
  )
}

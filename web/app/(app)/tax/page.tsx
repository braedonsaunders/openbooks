import Link from 'next/link'
import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/db.ts'
import { Badge } from '@openbooks/ui'
import { PageContainer } from '../../../components/page-layout'
import { SearchInput } from '../../../components/search-input'
import { FilterChips } from '../../../components/filter-bar'
import { Pagination } from '../../../components/pagination'
import { SortTh } from '../../../components/sortable-th'
import { can, requirePermission } from '../../../lib/authz'
import { isUuid, mergeHref, parseListParams, pickString } from '../../../lib/list-params'
import { FilingHistoryDrawer, type FilingHistoryRecord } from './FilingHistoryDrawer'
import { TaxFilingsView } from './TaxFilingsView'

export const dynamic = 'force-dynamic'

type FormRow = {
  code: string
  name: string
  country: string | null
  submission_channel: string
  government_format: string
  submission_url: string | null
  has_official: boolean
}

type FilingRow = FilingHistoryRecord & { created_at: string }

export default async function TaxPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const authz = await requirePermission('reports.read')
  const { orgId } = authz.user
  const sp = await searchParams
  const t = await getTranslations('tax')
  const list = parseListParams(sp, { sort: 'period', dir: 'desc', perPage: 20, allowedSorts: ['period', 'form', 'status', 'created'] as const })
  const status = pickString(sp.status)
  const formCode = pickString(sp.form)
  const filingId = pickString(sp.filing)

  const formsResult = (await db.execute(sql`
    select code, name, country, submission_channel, government_format, submission_url,
           official_pdf_file_id is not null as has_official
      from tax_return_forms
     where org_id = ${orgId} and is_active
     order by country nulls last, name`)) as unknown as { rows: FormRow[] }
  const forms = formsResult.rows

  const filters = sql`where org_id = ${orgId}
    ${status === 'prepared' || status === 'filed' ? sql`and status = ${status}` : sql``}
    ${formCode && forms.some((form) => form.code === formCode) ? sql`and form_code = ${formCode}` : sql``}
    ${list.q ? sql`and (
      form_name ilike ${`%${list.q}%`} or form_code ilike ${`%${list.q}%`} or
      coalesce(filing_reference, '') ilike ${`%${list.q}%`} or
      cast(period_from as text) ilike ${`%${list.q}%`} or cast(period_to as text) ilike ${`%${list.q}%`}
    )` : sql``}`
  const order = list.sort === 'form'
    ? sql`form_name ${list.dir === 'asc' ? sql`asc` : sql`desc`}, period_to desc`
    : list.sort === 'status'
      ? sql`status ${list.dir === 'asc' ? sql`asc` : sql`desc`}, period_to desc`
      : list.sort === 'created'
        ? sql`created_at ${list.dir === 'asc' ? sql`asc` : sql`desc`}`
        : sql`period_to ${list.dir === 'asc' ? sql`asc` : sql`desc`}, version desc`

  const [historyResult, countResult, selectedResult] = await Promise.all([
    db.execute(sql`
      select id, form_name, form_code, country, period_from::text, period_to::text,
             version, status, filing_reference, filed_at::text, snapshot_hash, boxes, created_at::text
        from tax_filings ${filters}
       order by ${order}
       limit ${list.perPage} offset ${(list.page - 1) * list.perPage}`) as unknown as Promise<{ rows: FilingRow[] }>,
    db.execute(sql`select count(*)::int as count from tax_filings ${filters}`) as unknown as Promise<{ rows: { count: number }[] }>,
    filingId && isUuid(filingId)
      ? db.execute(sql`
          select id, form_name, form_code, country, period_from::text, period_to::text,
                 version, status, filing_reference, filed_at::text, snapshot_hash, boxes
            from tax_filings where id = ${filingId} and org_id = ${orgId} limit 1`) as unknown as Promise<{ rows: FilingHistoryRecord[] }>
      : Promise.resolve({ rows: [] as FilingHistoryRecord[] }),
  ])
  const history = historyResult.rows
  const total = Number(countResult.rows[0]?.count ?? 0)
  const selected = selectedResult.rows[0]
  const closeHref = mergeHref('/tax', sp, { filing: undefined })

  return (
    <PageContainer>
      <div className="space-y-8">
        <TaxFilingsView forms={forms} canSave={can(authz, 'reports.create')} canManageSetup={can(authz, 'admin.setup.manage')} />

        <section className="space-y-4 border-t border-slate-200 pt-6 dark:border-slate-800">
          <div>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">{t('history.title')}</h2>
            <p className="text-sm text-slate-500 dark:text-slate-400">{t('history.description')}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput placeholder={t('history.search')} />
            <FilterChips
              basePath="/tax"
              currentParams={sp}
              paramKey="status"
              label={t('history.statusLabel')}
              options={[
                { value: 'prepared', label: t('history.status.prepared') },
                { value: 'filed', label: t('history.status.filed') },
              ]}
            />
            <FilterChips
              basePath="/tax"
              currentParams={sp}
              paramKey="form"
              label={t('form')}
              options={forms.map((form) => ({ value: form.code, label: form.name }))}
            />
          </div>
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-400">
                  <tr>
                    <SortTh basePath="/tax" currentParams={sp} column="form" sort={list.sort} dir={list.dir}>{t('history.columns.form')}</SortTh>
                    <SortTh basePath="/tax" currentParams={sp} column="period" sort={list.sort} dir={list.dir}>{t('history.columns.period')}</SortTh>
                    <th className="px-3 py-2">{t('history.columns.version')}</th>
                    <SortTh basePath="/tax" currentParams={sp} column="status" sort={list.sort} dir={list.dir}>{t('history.columns.status')}</SortTh>
                    <th className="px-3 py-2">{t('history.columns.reference')}</th>
                    <SortTh basePath="/tax" currentParams={sp} column="created" sort={list.sort} dir={list.dir}>{t('history.columns.saved')}</SortTh>
                  </tr>
                </thead>
                <tbody>
                  {history.length === 0 ? (
                    <tr><td colSpan={6} className="px-3 py-8 text-center text-slate-500 dark:text-slate-400">{t('history.empty')}</td></tr>
                  ) : history.map((filing) => (
                    <tr key={filing.id} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                      <td className="px-3 py-2"><Link href={mergeHref('/tax', sp, { filing: filing.id }) as any} className="font-medium text-teal-700 hover:underline dark:text-teal-300">{filing.form_name}</Link><div className="font-mono text-xs text-slate-400">{filing.form_code}</div></td>
                      <td className="whitespace-nowrap px-3 py-2">{t('period', { from: filing.period_from, to: filing.period_to })}</td>
                      <td className="px-3 py-2 tabular-nums">{filing.version}</td>
                      <td className="px-3 py-2"><Badge variant={filing.status === 'filed' ? 'success' : 'warning'}>{t(`history.status.${filing.status}`)}</Badge></td>
                      <td className="px-3 py-2">{filing.filing_reference ?? '—'}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-slate-500 dark:text-slate-400">{filing.created_at.slice(0, 10)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination basePath="/tax" currentParams={sp} total={total} page={list.page} perPage={list.perPage} />
          </div>
        </section>
      </div>
      {selected ? <FilingHistoryDrawer filing={selected} closeHref={closeHref} canFile={can(authz, 'reports.create')} /> : null}
    </PageContainer>
  )
}

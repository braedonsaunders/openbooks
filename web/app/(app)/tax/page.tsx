import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { notFound } from 'next/navigation'
import { db } from '@openbooks/engine/src/db.ts'
import { can, requirePermission } from '../../../lib/authz'
import { isUuid, mergeHref, parseListParams, pickString } from '../../../lib/list-params'
import { ModuleView } from '../../../components/viewspec/module-view'
import { loadTax, taxSpec } from './view'
import {
  TaxFilingDrawer,
  TaxHistoryTable,
  TaxPageHeader,
  TaxPageShell,
  TaxPreparePanel,
  TaxTabPanels,
  TaxTabs,
  type TaxFormOption,
} from './sections'
import type { FilingHistoryRecord } from './FilingHistoryDrawer'

export const dynamic = 'force-dynamic'

type FormRow = TaxFormOption

type FilingRow = FilingHistoryRecord & { created_at: string }

export default async function TaxPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if ((await searchParams).__viewspec === '1') {
    const sp = await searchParams
    const data = await loadTax(sp)
    return (
      <>
        {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
        <meta name="x-viewspec-render" content="1" />
        <ModuleView spec={taxSpec(data)} data={data} searchParams={sp} trusted />
      </>
    )
  }
  const authz = await requirePermission('reports.read')
  // Returns and filings have no subsidiary dimension: every tax REST path
  // refuses an entity-restricted caller (guardSubsidiaryScope(gate, null) → 404),
  // and this page applies the identical fence rather than rendering the
  // org-wide filing history to them.
  if (authz.allowedSubsidiaryIds !== null) notFound()
  const { orgId } = authz.user
  const sp = await searchParams
  const t = await getTranslations('tax')
  const tab = pickString(sp.tab) === 'history' ? 'history' : 'prepare'
  const list = parseListParams(sp, { sort: 'period', dir: 'desc', perPage: 20, allowedSorts: ['period', 'form', 'status', 'created'] as const })
  const status = pickString(sp.status)
  const formCode = pickString(sp.form)
  const filingId = pickString(sp.filing)
  const canManageSetup = can(authz, 'admin.setup.manage')

  const formsResult = (await db.execute<FormRow>(sql`
    select code, name, country, submission_channel, government_format, submission_url,
           official_pdf_file_id is not null as has_official
      from tax_return_forms
     where org_id = ${orgId} and is_active
     order by country nulls last, name`))
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

  // Total filings drives the History tab's count badge (always cheap); the full
  // history rows are only queried when that tab is open.
  const [badgeResult, historyResult, countResult, selectedResult] = await Promise.all([
    db.execute<{ count: number }>(sql`select count(*)::int as count from tax_filings where org_id = ${orgId}`),
    tab === 'history'
      ? db.execute<FilingRow>(sql`
          select id, form_name, form_code, country, period_from::text, period_to::text,
                 version, status, filing_reference, filed_at::text, snapshot_hash, boxes, created_at::text
            from tax_filings ${filters}
           order by ${order}
           limit ${list.perPage} offset ${(list.page - 1) * list.perPage}`)
      : Promise.resolve({ rows: [] as FilingRow[] }),
    tab === 'history'
      ? db.execute<{ count: number }>(sql`select count(*)::int as count from tax_filings ${filters}`)
      : Promise.resolve({ rows: [{ count: 0 }] }),
    filingId && isUuid(filingId)
      ? db.execute<FilingHistoryRecord>(sql`
          select id, form_name, form_code, country, period_from::text, period_to::text,
                 version, status, filing_reference, filed_at::text, snapshot_hash, boxes
            from tax_filings where id = ${filingId} and org_id = ${orgId} limit 1`)
      : Promise.resolve({ rows: [] as FilingHistoryRecord[] }),
  ])
  const badgeCount = Number(badgeResult.rows[0]?.count ?? 0)
  const history = historyResult.rows
  const total = Number(countResult.rows[0]?.count ?? 0)
  const selected = selectedResult.rows[0]
  const closeHref = mergeHref('/tax', sp, { filing: undefined })

  const tabs = [
    { key: 'prepare', label: t('tabs.prepare'), href: '/tax', active: tab === 'prepare', count: null },
    { key: 'history', label: t('tabs.history'), href: '/tax?tab=history', active: tab === 'history', count: badgeCount },
  ]

  return (
    <TaxPageShell>
      <TaxPageHeader
        title={t('title')}
        description={t('description')}
        setupHref="/admin/setup/tax-return-forms"
        setupLabel={t('setup')}
        canManageSetup={canManageSetup}
      />
      <TaxTabs tabs={tabs} />
      <TaxTabPanels
        tabKey={tab}
        onPrepare={tab === 'prepare'}
        onHistory={tab === 'history'}
        prepare={
          <TaxPreparePanel forms={forms} canSave={can(authz, 'reports.create')} canManageSetup={canManageSetup} />
        }
        history={
          <TaxHistoryTable
            searchPlaceholder={t('history.search')}
            statusLabel={t('history.statusLabel')}
            statusOptions={[
              { value: 'prepared', label: t('history.status.prepared') },
              { value: 'filed', label: t('history.status.filed') },
            ]}
            formLabel={t('form')}
            formOptions={forms.map((form) => ({ value: form.code, label: form.name }))}
            basePath="/tax"
            currentParams={sp}
            total={total}
            page={list.page}
            perPage={list.perPage}
            sort={list.sort}
            dir={list.dir}
            columnForm={t('history.columns.form')}
            columnPeriod={t('history.columns.period')}
            columnVersion={t('history.columns.version')}
            columnStatus={t('history.columns.status')}
            columnReference={t('history.columns.reference')}
            columnSaved={t('history.columns.saved')}
            empty={t('history.empty')}
            rows={history.map((filing) => ({
              id: String(filing.id),
              formName: filing.form_name,
              formCode: filing.form_code,
              filingHref: mergeHref('/tax', sp, { filing: filing.id }),
              period: t('period', { from: filing.period_from, to: filing.period_to }),
              version: filing.version,
              status: filing.status,
              statusVariant: (filing.status === 'filed' ? 'success' : 'warning') as 'success' | 'warning',
              statusLabel: t(`history.status.${filing.status}`),
              reference: filing.filing_reference ?? '—',
              saved: filing.created_at.slice(0, 10),
            }))}
          />
        }
      />
      <TaxFilingDrawer
        drawer={
          selected
            ? {
                remountKey: String(selected.id),
                filing: selected,
                closeHref,
                canFile: can(authz, 'reports.create'),
              }
            : null
        }
      />
    </TaxPageShell>
  )
}

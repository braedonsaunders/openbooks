import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { ArrowLeft } from 'lucide-react'
import { Button, PageHeader } from '@openbooks/ui'
import { db } from '@openbooks/engine/src/db.ts'
import { getDocumentCaptureSettings } from '@openbooks/engine/src/ap-capture-config.ts'
import { ListPageLayout } from '../../../../components/page-layout'
import { SearchInput } from '../../../../components/search-input'
import { FilterChips } from '../../../../components/filter-bar'
import { Pagination } from '../../../../components/pagination'
import { parseListParams, pickString } from '../../../../lib/list-params'
import { requirePermission, can } from '../../../../lib/authz'
import { CaptureUploadButton } from './CaptureUploadButton'
import { CaptureList, type CaptureListRow } from './CaptureList'
import { CaptureReviewDrawer, type CaptureDetail } from './CaptureReviewDrawer'

export const dynamic = 'force-dynamic'

const STATUSES = ['queued', 'extracting', 'needs_review', 'ready', 'duplicate', 'failed', 'materialized', 'rejected'] as const
const SORTS = ['received', 'filename', 'status', 'total'] as const

export default async function ApCapturePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const authz = await requirePermission('ap.read')
  const canCreate = can(authz, 'ap.create')
  const t = await getTranslations('ap.capture')
  const tc = await getTranslations('common')
  const sp = await searchParams
  const list = parseListParams(sp, { sort: 'received', dir: 'desc', perPage: 25, allowedSorts: SORTS })
  const requestedStatus = pickString(sp.status)
  const status = STATUSES.includes(requestedStatus as (typeof STATUSES)[number]) ? requestedStatus : undefined
  const search = list.q ? `%${list.q.replace(/[\\%_]/g, '\\$&')}%` : null
  const allowed = authz.allowedSubsidiaryIds ? [...authz.allowedSubsidiaryIds] : null
  const subsidiaryScope = allowed === null
    ? sql``
    : allowed.length === 0
      ? sql`and false`
      : sql`and (po.subsidiary_id is null or po.subsidiary_id in (${sql.join(allowed.map((id) => sql`${id}`), sql`, `)}))
              and (vendor.subsidiary_id is null or vendor.subsidiary_id in (${sql.join(allowed.map((id) => sql`${id}`), sql`, `)}))`
  const where = sql`
    ci.org_id = ${authz.user.orgId}
    ${status ? sql`and ci.status = ${status}` : sql``}
    ${search ? sql`and (ci.original_filename ilike ${search} escape '\\'
      or ci.normalized->>'vendorName' ilike ${search} escape '\\'
      or ci.normalized->>'invoiceNumber' ilike ${search} escape '\\'
      or vendor.display_name ilike ${search} escape '\\')` : sql``}
    ${subsidiaryScope}
  `
  const order = list.sort === 'filename'
    ? sql`ci.original_filename ${list.dir === 'asc' ? sql`asc` : sql`desc`}`
    : list.sort === 'status'
      ? sql`ci.status ${list.dir === 'asc' ? sql`asc` : sql`desc`}, ci.received_at desc`
      : list.sort === 'total'
        ? sql`nullif(ci.normalized->>'total','')::numeric ${list.dir === 'asc' ? sql`asc` : sql`desc`} nulls last`
        : sql`ci.received_at ${list.dir === 'asc' ? sql`asc` : sql`desc`}`
  const offset = (list.page - 1) * list.perPage
  const [rowsResult, totalResult, countsResult, captureSettings, globalResult] = await Promise.all([
    db.execute(sql`
      select ci.id, ci.status, ci.original_filename as "filename", ci.document_kind as "documentKind",
             ci.normalized->>'vendorName' as "vendorName", ci.normalized->>'invoiceNumber' as "invoiceNumber",
             ci.normalized->>'invoiceDate' as "invoiceDate", ci.normalized->>'currency' as currency,
             ci.normalized->>'total' as total, ci.overall_confidence as "overallConfidence",
             ci.validation_issues as "validationIssues", ci.document_id as "documentId",
             ci.received_at as "receivedAt", vendor.display_name as "resolvedVendor"
        from ap_capture_items ci
        left join parties vendor on vendor.id = ci.vendor_candidate_id
        left join documents po on po.id = ci.purchase_order_id
       where ${where} order by ${order} limit ${list.perPage} offset ${offset}
    `),
    db.execute(sql`
      select count(*)::int as n from ap_capture_items ci
      left join parties vendor on vendor.id = ci.vendor_candidate_id
      left join documents po on po.id = ci.purchase_order_id
      where ${where}
    `),
    db.execute(sql`
      select status, count(*)::int as n from ap_capture_items where org_id = ${authz.user.orgId} group by status
    `),
    getDocumentCaptureSettings(authz.user.orgId),
    db.execute(sql`select coalesce((settings->'ai'->>'enabled')::boolean, true) as enabled from orgs where id = ${authz.user.orgId}`),
  ])
  const rows = (rowsResult as unknown as { rows: CaptureListRow[] }).rows
  const total = Number((totalResult as any).rows[0]?.n ?? 0)
  const counts = new Map<string, number>((countsResult as any).rows.map((row: any) => [row.status, Number(row.n)]))
  const selectedId = pickString(sp.capture)
  let detail: CaptureDetail | null = null
  let options: { vendors: any[]; accounts: any[]; purchaseOrders: any[] } | null = null
  if (selectedId) {
    const selected = (await db.execute<CaptureDetail>(sql`
      select ci.*, f.content_type as "contentType", f.size_bytes as "sizeBytes",
             vendor.display_name as "resolvedVendor", po.document_number as "purchaseOrderNumber"
        from ap_capture_items ci join files f on f.id = ci.file_id
        left join parties vendor on vendor.id = ci.vendor_candidate_id
        left join documents po on po.id = ci.purchase_order_id
       where ci.org_id = ${authz.user.orgId} and ci.id = ${selectedId}
       ${subsidiaryScope}
    `))
    detail = selected.rows[0] ?? null
    if (detail) {
      const vendorScope = allowed === null
        ? sql``
        : allowed.length === 0
          ? sql`and false`
          : sql`and (p.subsidiary_id is null or p.subsidiary_id in (${sql.join(allowed.map((id) => sql`${id}`), sql`, `)}))`
      const poScope = allowed === null
        ? sql``
        : allowed.length === 0
          ? sql`and false`
          : sql`and (d.subsidiary_id is null or d.subsidiary_id in (${sql.join(allowed.map((id) => sql`${id}`), sql`, `)}))`
      const [vendors, accounts, purchaseOrders, evidence] = await Promise.all([
        db.execute(sql`
          select p.id, p.display_name as label from parties p join vendor_roles vr on vr.party_id = p.id
           where p.org_id = ${authz.user.orgId} and p.is_active and vr.is_active ${vendorScope}
           order by p.display_name limit 2000
        `),
        db.execute(sql`
          select id, concat_ws(' · ', number, name) as label from accounts
           where org_id = ${authz.user.orgId} and is_active and not is_summary order by number nulls last limit 3000
        `),
        db.execute(sql`
          select d.id, d.document_number as label from documents d
           where d.org_id = ${authz.user.orgId} and d.kind = 'purchase_order' and d.status = 'approved' ${poScope}
           order by d.document_date desc limit 1000
        `),
        db.execute(sql`
          select af.field_key as "fieldKey", af.line_index as "lineIndex", af.confidence,
                 af.page_number as "pageNumber", af.polygon
            from ap_capture_fields af join ap_capture_runs ar on ar.id = af.run_id
           where af.org_id = ${authz.user.orgId} and ar.capture_item_id = ${selectedId}
             and ar.attempt = (select max(attempt) from ap_capture_runs where capture_item_id = ${selectedId})
        `),
      ])
      detail.evidence = (evidence as any).rows
      options = { vendors: (vendors as any).rows, accounts: (accounts as any).rows, purchaseOrders: (purchaseOrders as any).rows }
    }
  }
  const captureOperational = Boolean((globalResult as any).rows[0]?.enabled)
    && captureSettings.enabled && captureSettings.hasKey && Boolean(captureSettings.endpoint)
  const actions = (
    <div className="flex items-center gap-2">
      <Button variant="outline" asChild><Link href="/ap"><ArrowLeft size={14} />{t('backToBills')}</Link></Button>
      {canCreate ? <CaptureUploadButton disabled={!captureOperational} /> : null}
    </div>
  )
  return (
    <ListPageLayout
      header={
        <>
          <PageHeader title={t('title')} description={t('description')} actions={actions} />
          {!captureOperational ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
              {t('notConfigured')} {can(authz, 'admin.ai.manage') ? <Link href="/admin/ai" className="font-medium underline">{t('configure')}</Link> : null}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <SearchInput placeholder={t('search')} />
            <FilterChips basePath="/ap/capture" currentParams={sp} paramKey="status" label={tc('labels.status')} options={STATUSES.map((value) => ({ value, label: t(`status.${value}`), count: counts.get(value) ?? 0 }))} />
          </div>
        </>
      }
    >
      <CaptureList rows={rows} currentParams={sp} canCreate={canCreate} sort={list.sort} dir={list.dir} />
      <Pagination basePath="/ap/capture" currentParams={sp} total={total} page={list.page} perPage={list.perPage} />
      {detail && options ? <CaptureReviewDrawer initial={detail} vendors={options.vendors} accounts={options.accounts} purchaseOrders={options.purchaseOrders} canCreate={canCreate} /> : null}
    </ListPageLayout>
  )
}

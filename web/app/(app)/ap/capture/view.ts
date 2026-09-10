import 'server-only'

import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { getDocumentCaptureSettings } from '@openbooks/engine/src/ap-capture-config.ts'
import {
  grid,
  page,
  pageHeader,
  pagination,
  ref,
  widget,
  widgetBlock,
  type PageSpec,
} from '@openbooks/viewspec'
import { parseListParams, pickString } from '../../../../lib/list-params'
import { can, requirePermission } from '../../../../lib/authz'
import { isDocKindEnabled } from '../../../../lib/documents'
import type { CaptureListRow } from './sections'
import type { CaptureDetail } from './CaptureReviewDrawer'

/**
 * Bill capture, split into a loader and a spec.
 *
 * The list is a WIDGET, not a `table` block — see the note on `CaptureList`:
 * the native page hand-rolls selection state, per-row checkboxes, and three
 * bulk actions the spec's table vocabulary cannot name (same treatment as
 * `AdminUsersTable`). Everything around it — the header, the search/filter
 * row, the pager — is ordinary spec, and the review drawer rides through a
 * widget ref with a remount key, the same pattern as `account-drawer`.
 *
 * The loader reproduces page.tsx VERBATIM: the permission gate, the
 * search/sort/page parsing, the subsidiary scoping on both the list queries
 * and the counts, the capture-settings + global-AI resolution behind the
 * upload button, and the ?capture= flyout resolution (org guard, subsidiary
 * guard, vendor/PO/account option lists, latest-attempt evidence) plus the
 * purchase-order kind check.
 */

const STATUSES = ['queued', 'extracting', 'needs_review', 'ready', 'duplicate', 'failed', 'materialized', 'rejected'] as const
const SORTS = ['received', 'filename', 'status', 'total'] as const

export interface ApCaptureDrawer {
  /** Remount key: switching documents must reset the drawer's client state. */
  remountKey: string
  initial: CaptureDetail
  vendors: { id: string; label: string }[]
  accounts: { id: string; label: string }[]
  purchaseOrders: { id: string; label: string }[]
  canLookupPurchaseOrders: boolean
  canCreate: boolean
}

export interface ApCaptureData {
  title: string
  description: string
  backHref: string
  backLabel: string
  currentParams: Record<string, string | string[] | undefined>
  canCreate: boolean
  showBanner: boolean
  notConfiguredText: string
  showConfigureLink: boolean
  configureHref: string
  configureLabel: string
  searchPlaceholder: string
  statusLabel: string
  statusOptions: { value: string; label: string; count: number }[]
  uploadDisabled: boolean
  sort: string
  dir: 'asc' | 'desc'
  rows: CaptureListRow[]
  total: number
  currentPage: number
  perPage: number
  drawerOpen: boolean
  drawer: ApCaptureDrawer | null
}

export async function loadApCapture(
  sp: Record<string, string | string[] | undefined>,
): Promise<ApCaptureData> {
  const authz = await requirePermission('ap.read')
  const canCreate = can(authz, 'ap.create')
  const t = await getTranslations('ap.capture')
  const tc = await getTranslations('common')
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
        left join parties vendor on vendor.id = ci.vendor_candidate_id and vendor.org_id = ci.org_id
        left join documents po on po.id = ci.purchase_order_id and po.org_id = ci.org_id
       where ${where} order by ${order} limit ${list.perPage} offset ${offset}
    `),
    db.execute(sql`
      select count(*)::int as n from ap_capture_items ci
      left join parties vendor on vendor.id = ci.vendor_candidate_id and vendor.org_id = ci.org_id
      left join documents po on po.id = ci.purchase_order_id and po.org_id = ci.org_id
      where ${where}
    `),
    db.execute(sql`
      select ci.status, count(*)::int as n from ap_capture_items ci
      left join parties vendor on vendor.id = ci.vendor_candidate_id and vendor.org_id = ci.org_id
      left join documents po on po.id = ci.purchase_order_id and po.org_id = ci.org_id
       where ci.org_id = ${authz.user.orgId}
         ${subsidiaryScope}
       group by ci.status
    `),
    getDocumentCaptureSettings(authz.user.orgId),
    db.execute(sql`select coalesce((settings->'ai'->>'enabled')::boolean, true) as enabled from orgs where id = ${authz.user.orgId}`),
  ])
  const rows = (rowsResult as unknown as { rows: CaptureListRow[] }).rows
  const total = Number(((totalResult) as unknown as { rows: { n: number }[] }).rows[0]?.n ?? 0)
  const counts = new Map<string, number>(((countsResult) as unknown as { rows: { status: string; n: number }[] }).rows.map((row) => [row.status, Number(row.n)]))
  const selectedId = pickString(sp.capture)
  let detail: CaptureDetail | null = null
  let options: { vendors: { id: string; label: string }[]; accounts: { id: string; label: string }[]; purchaseOrders: { id: string; label: string }[] } | null = null
  let canLookupPurchaseOrders = false
  if (selectedId) {
    const selected = (await db.execute<CaptureDetail>(sql`
      select ci.*, f.content_type as "contentType", f.size_bytes as "sizeBytes",
             vendor.display_name as "resolvedVendor", po.document_number as "purchaseOrderNumber"
        from ap_capture_items ci join files f on f.id = ci.file_id and f.org_id = ci.org_id
        left join parties vendor on vendor.id = ci.vendor_candidate_id and vendor.org_id = ci.org_id
        left join documents po on po.id = ci.purchase_order_id and po.org_id = ci.org_id
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
      canLookupPurchaseOrders = await isDocKindEnabled(authz.user.orgId, 'purchase_order')
      const [vendors, accounts, purchaseOrders, evidence] = await Promise.all([
        db.execute(sql`
          select p.id, p.display_name as label from parties p join vendor_roles vr on vr.party_id = p.id and vr.org_id = p.org_id
           where p.org_id = ${authz.user.orgId} and p.is_active and vr.is_active ${vendorScope}
           order by p.display_name limit 2000
        `),
        db.execute(sql`
          select id, concat_ws(' · ', number, name) as label from accounts
           where org_id = ${authz.user.orgId} and is_active and not is_summary order by number nulls last limit 3000
        `),
        canLookupPurchaseOrders
          ? db.execute(sql`
          select d.id, d.document_number as label from documents d
           where d.org_id = ${authz.user.orgId} and d.kind = 'purchase_order' and d.status = 'approved' ${poScope}
           order by d.document_date desc limit 1000
        `)
          : Promise.resolve({ rows: [] }),
        db.execute(sql`
          select af.field_key as "fieldKey", af.line_index as "lineIndex", af.confidence,
                 af.page_number as "pageNumber", af.polygon
            from ap_capture_fields af join ap_capture_runs ar on ar.id = af.run_id and ar.org_id = af.org_id
           where af.org_id = ${authz.user.orgId} and ar.capture_item_id = ${selectedId}
             and ar.attempt = (select max(attempt) from ap_capture_runs where capture_item_id = ${selectedId} and org_id = ${authz.user.orgId})
        `),
      ])
      detail.evidence = (evidence as unknown as { rows: CaptureDetail['evidence'] }).rows
      options = {
        vendors: ((vendors) as unknown as { rows: { id: string; label: string }[] }).rows,
        accounts: ((accounts) as unknown as { rows: { id: string; label: string }[] }).rows,
        purchaseOrders: ((purchaseOrders) as unknown as { rows: { id: string; label: string }[] }).rows,
      }
    }
  }
  const captureOperational = Boolean(((globalResult) as unknown as { rows: { enabled: boolean }[] }).rows[0]?.enabled)
    && captureSettings.enabled && captureSettings.hasKey && Boolean(captureSettings.endpoint)
  const drawer: ApCaptureDrawer | null = detail && options
    ? {
        remountKey: String(detail.id),
        initial: detail,
        vendors: options.vendors,
        accounts: options.accounts,
        purchaseOrders: options.purchaseOrders,
        canLookupPurchaseOrders,
        canCreate,
      }
    : null
  return {
    title: t('title'),
    description: t('description'),
    backHref: '/ap',
    backLabel: t('backToBills'),
    currentParams: sp,
    canCreate,
    showBanner: !captureOperational,
    notConfiguredText: t('notConfigured'),
    showConfigureLink: can(authz, 'admin.ai.manage'),
    configureHref: '/admin/ai',
    configureLabel: t('configure'),
    searchPlaceholder: t('search'),
    statusLabel: tc('labels.status'),
    statusOptions: STATUSES.map((value) => ({ value, label: t(`status.${value}`), count: counts.get(value) ?? 0 })),
    uploadDisabled: !captureOperational,
    sort: list.sort,
    dir: list.dir,
    rows,
    total,
    currentPage: list.page,
    perPage: list.perPage,
    drawerOpen: Boolean(drawer),
    drawer,
  }
}

const f = ref<ApCaptureData>()

export function apCaptureSpec(data: ApCaptureData): PageSpec {
  const upload = {
    widget: 'capture-upload',
    props: { disabled: data.uploadDisabled },
  }
  return page({
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actionsClassName: 'flex items-center gap-2',
        actions: [
          widget('back-link-button', { href: data.backHref, label: data.backLabel }),
          widget(upload.widget, upload.props, f('canCreate')),
        ],
      }),
      {
        ...grid('rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300', [
          widgetBlock('capture-not-configured', {
            text: data.notConfiguredText,
            configureHref: data.configureHref,
            configureLabel: data.configureLabel,
            showConfigureLink: data.showConfigureLink,
          }),
        ]),
        when: f('showBanner'),
      },
      grid('flex flex-wrap gap-2', [
        widgetBlock('search-input', { placeholder: data.searchPlaceholder }),
        widgetBlock('filter-chips', {
          basePath: '/ap/capture',
          currentParams: data.currentParams,
          paramKey: 'status',
          label: data.statusLabel,
          options: data.statusOptions,
        }),
      ]),
    ],
    body: [
      widgetBlock('capture-list', {
        rows: data.rows,
        currentParams: data.currentParams,
        canCreate: data.canCreate,
        sort: data.sort,
        dir: data.dir,
      }),
      pagination({
        basePath: '/ap/capture',
        total: f('total'),
        page: f('currentPage'),
        perPage: f('perPage'),
        // The native pager is unwrapped here — no `mt-3` spacer.
        bare: true,
      }),
      {
        ...widgetBlock('capture-review-drawer', {
          drawer: data.drawer,
        }),
        when: f('drawerOpen'),
      },
    ],
  })
}
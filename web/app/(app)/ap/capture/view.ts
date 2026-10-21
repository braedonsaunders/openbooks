import { isFeatureEnabled } from '@/lib/features'
import 'server-only'

import { getLocale, getTranslations } from 'next-intl/server'
import { headers } from 'next/headers'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/platform/db'
import { businessToday } from '@openbooks/engine/platform/business-date'
import { withScopeSnapshot } from '@openbooks/engine/organization/scope'
import { documentRevisionCounterSql } from '@openbooks/engine/records/revision'
import { documentCaptureOperational, getDocumentCaptureSettings } from '@openbooks/engine/payables/ap-capture-config'
import {
  DEFAULT_TRUST_STREAK,
  listInboundMessages,
  listMailboxes,
  resolveAutoPostPolicy,
  vendorCaptureTrust,
} from '@openbooks/engine/payables/ap-capture-service'
import {
  badge,
  column,
  field,
  grid,
  link,
  number,
  page,
  pageHeader,
  pagination,
  ref,
  table,
  text,
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import type { ModuleHomeTab } from '../../../../components/module-home/tab-types'
import { dateTime } from '../../../../lib/format'
import { isUuid, mergeHref, parseListParams, pickString } from '../../../../lib/list-params'
import { can, requirePermission } from '../../../../lib/authz'
import { isDocKindEnabled } from "../../../../lib/documents.ts";
import type { CaptureListRow, CaptureMailbox } from './sections'
import type { CaptureDetail, CaptureNavigation, CaptureAutoPostState, CaptureTrustState } from './CaptureReviewDrawer'

/**
 * Bill capture, split into a loader and a spec.
 *
 * Two peer tabs on the shared subtab strip: the capture queue (the review
 * list and its drawer) and inbox activity (every inbound email and what
 * became of it). One concept per tab, never stacked.
 *
 * The queue list is a WIDGET, not a `table` block — see the note on
 * `CaptureList`: the native page hand-rolls selection state, per-row
 * checkboxes, and three bulk actions the spec's table vocabulary cannot name
 * (same treatment as `AdminUsersTable`). Everything around it — the header,
 * the search/filter row, the pager — is ordinary spec, and the review drawer
 * rides through a widget ref with a remount key, the same pattern as
 * `account-drawer`. The inbox activity log is read-only, so it is an
 * ordinary spec table.
 *
 * The loader applies the permission gate, the search/sort/page parsing, the
 * subsidiary scoping on both the list queries and the counts, the
 * capture-settings + global-AI resolution behind the upload button, and the
 * ?capture= flyout resolution (org guard, subsidiary guard, vendor/PO/account
 * option lists, latest-attempt evidence, list neighbours for keyboard
 * review, vendor trust and the latest auto-post decision) plus the
 * purchase-order kind check.
 */

const STATUSES = ['queued', 'extracting', 'needs_review', 'ready', 'duplicate', 'failed', 'materialized', 'rejected'] as const
const SORTS = ['received', 'filename', 'status', 'total'] as const
const OUTCOMES = ['received', 'captured', 'rejected_sender', 'no_attachments', 'duplicate', 'error'] as const
const OUTCOME_VARIANT: Record<string, 'success' | 'warning' | 'destructive' | 'secondary' | 'outline'> = {
  received: 'secondary', captured: 'success', rejected_sender: 'warning', no_attachments: 'outline', duplicate: 'outline', error: 'destructive',
}
const AUTO_POST_EVENTS = ['auto_posted', 'auto_post_submitted', 'auto_post_refused', 'auto_post_skipped'] as const

export interface ApCaptureDrawer {
  /** Remount key: switching documents must reset the drawer's client state. */
  remountKey: string
  initial: CaptureDetail
  vendors: { id: string; label: string }[]
  accounts: { id: string; label: string }[]
  purchaseOrders: { id: string; label: string }[]
  canLookupPurchaseOrders: boolean
  canCreate: boolean
  canApprovePriceOverride: boolean
  canPost: boolean
  navigation: CaptureNavigation
  trust: CaptureTrustState | null
  autoPost: CaptureAutoPostState | null
  attentionThreshold: string
}

export interface InboxActivityRow {
  id: string
  receivedLine: string
  mailboxLabel: string
  fromLine: string
  subjectLine: string
  attachmentCount: number
  outcomeLabel: string
  outcomeVariant: string
  detailLine: string
  captureHref: string
  captureLabel: string
}

export interface ApCaptureData {
  title: string
  description: string
  backHref: string
  backLabel: string
  currentParams: Record<string, string | string[] | undefined>
  tabs: ModuleHomeTab[]
  onQueue: boolean
  onInbox: boolean
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
  mailboxes: CaptureMailbox[]
  manageMailboxesHref: string | null
  total: number
  currentPage: number
  perPage: number
  drawerOpen: boolean
  drawer: ApCaptureDrawer | null
  inbox: {
    rows: InboxActivityRow[]
    hasRows: boolean
    empty: boolean
    emptyTitle: string
    emptyDescription: string
    total: number
    currentPage: number
    perPage: number
    columns: Record<'received' | 'address' | 'from' | 'subject' | 'attachments' | 'outcome' | 'detail' | 'capture', string>
  }
}

/** The externally reachable origin for webhook URLs: the configured app URL, else this request's host. */
async function publicOrigin(): Promise<string> {
  const configured = process.env.OPENBOOKS_APP_URL?.trim().replace(/\/+$/, '')
  if (configured) return configured
  const incoming = await headers()
  const host = incoming.get('x-forwarded-host') ?? incoming.get('host') ?? 'localhost'
  const proto = incoming.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https')
  return `${proto}://${host}`
}

export async function loadApCapture(
  sp: Record<string, string | string[] | undefined>,
): Promise<ApCaptureData> {
  const authz = await requirePermission('ap.read')
  return withScopeSnapshot(authz.user.orgId, async () => {
  const canCreate = can(authz, 'ap.create')
  const t = await getTranslations('ap.capture')
  const ti = await getTranslations('apInbox')
  const tc = await getTranslations('common')
  const locale = await getLocale()
  const tab = pickString(sp.tab) === 'inbox' ? 'inbox' : 'queue'
  const list = parseListParams(sp, { sort: 'received', dir: 'desc', perPage: 25, allowedSorts: SORTS })
  const requestedStatus = pickString(sp.status)
  const status = STATUSES.includes(requestedStatus as (typeof STATUSES)[number]) ? requestedStatus : undefined
  const search = list.q ? `%${list.q.replace(/[\\%_]/g, '\\$&')}%` : null
  const allowedSet = authz.allowedSubsidiaryIds
  const allowed = allowedSet ? [...allowedSet] : null
  const subsidiaryScope = allowed === null
    ? sql``
    : allowed.length === 0
      ? sql`and false`
      : sql`and (po.subsidiary_id is null or po.subsidiary_id in (${sql.join(allowed.map((id) => sql`${id}`), sql`, `)}))
              and (vendor.subsidiary_id is null or vendor.subsidiary_id in (${sql.join(allowed.map((id) => sql`${id}`), sql`, `)}))
              and (ci.subsidiary_id is null or ci.subsidiary_id in (${sql.join(allowed.map((id) => sql`${id}`), sql`, `)}))`
  const where = sql`
    ci.org_id = ${authz.user.orgId}
    ${status ? sql`and ci.status = ${status}` : sql``}
    ${search ? sql`and (ci.original_filename ilike ${search} escape '\\'
      or ci.normalized->>'vendorName' ilike ${search} escape '\\'
      or ci.normalized->>'invoiceNumber' ilike ${search} escape '\\'
      or vendor.display_name ilike ${search} escape '\\')` : sql``}
    ${subsidiaryScope}
  `
  // The id tiebreak makes the order total, so keyboard review walks exactly
  // the rows the list shows, in the order it shows them.
  const order = list.sort === 'filename'
    ? sql`ci.original_filename ${list.dir === 'asc' ? sql`asc` : sql`desc`}, ci.id desc`
    : list.sort === 'status'
      ? sql`ci.status ${list.dir === 'asc' ? sql`asc` : sql`desc`}, ci.received_at desc, ci.id desc`
      : list.sort === 'total'
        ? sql`nullif(ci.normalized->>'total','')::numeric ${list.dir === 'asc' ? sql`asc` : sql`desc`} nulls last, ci.id desc`
        : sql`ci.received_at ${list.dir === 'asc' ? sql`asc` : sql`desc`}, ci.id desc`
  const offset = (list.page - 1) * list.perPage
  const [rowsResult, totalResult, countsResult, providerOperational, mailboxRows] = await Promise.all([
    db.execute(sql`

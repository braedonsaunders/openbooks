'use client'

import { CLEAR_SEGMENT, INHERIT_SEGMENT, segmentCellValue, segmentAssignmentsFromCells } from '@/lib/segment-assignments'

import { useMoney } from '@/components/money-provider'
import { initialDrawerMode, type DrawerMode } from '@/lib/drawer-mode'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { ActionError, fetchAction, readActionResult } from '@braedonsaunders/appkit-errors'
import { ActionAlert } from '@braedonsaunders/appkit-errors/react'
import { useAppAction } from '@/lib/use-app-action'
import { basisForResolvedRow, parsePriceBasis, type PriceBasis } from '@/lib/price-basis'
import { Badge, Button, FieldLabel, Input, Label, SearchSelect } from '@openbooks/ui'
import { PromotionApplyControl } from '@/components/promotion-apply'
import { LineGrid, type LineGridColumn } from '../../../components/line-grid'
import { optionalScanResolver } from '../../../lib/scan'
import { TransactionDrawer } from '../../../components/transaction-drawer'
import { DocTypeBadge, docTypeMeta } from '../../../components/doc-type-badge'
import { ExternalRefChip } from '../../../components/external-ref-chip'
import { PdfButton } from '../../../components/pdf-button'
import { SendButton } from '../../../components/send-button'
import { confirmDialog } from '../../../lib/confirm'
import { isDocumentRevisionToken } from '@/lib/api/registry-data'
import { promptDialog } from '../../../lib/prompt'
import { FlowManualButtons } from '../../../components/flow-manual-buttons'
import { ApprovalActions } from '../../../components/approval-actions'
import { ApprovalHistory } from '../../../components/approval-history'
import { DropShipAssessmentButton } from './DropShipAssessmentButton'
import { OrderBackorders } from './OrderBackorders'
import { QuoteCashSection } from './QuoteCashSection'
import { QuoteAwardAction } from './QuoteAwardAction'
import { CONVERSION_TARGETS, type OrderKind } from '../../../lib/order-kinds'
import { HeaderFields } from '../../../components/transaction-form/header-fields'
import type { FormLayoutConfig, HeaderFieldPlacement } from '@openbooks/customization'
import { cmp, fromUnits, mul, sum, toUnits } from '@openbooks/engine/src/money/money.ts'
import { computeLineTaxes, type TaxComponentConfig } from '@openbooks/engine/src/tax/tax.ts'
import { fromQuantityUnits, toQuantityUnits } from '../../../lib/order-cycle-math'
type Opt = {
  id: string
  display_name?: string
  number?: string
  name?: string
  code?: string
  rate?: string
  default_rate?: string | null
  income_account_id?: string | null
  expense_account_id?: string | null
  tax_code_id?: string | null
  unit?: string | null
  tax_components?: TaxComponentConfig[]
  /** True when the item carries an inventory costing profile (line pickers). */
  has_inventory_profile?: boolean | null
};
interface LineRow extends Record<string, unknown> {
  /**
   * Client-only React identity for the line grid (never serialized — the
   * save payload picks explicit fields). Lets cell commits and price
   * tracking follow the row across reorder/duplicate/remove instead of the
   * position it used to occupy.
   */
  clientKey: string
  /** Persisted parent identity for row-scoped fulfillment controls; never sent by the draft serializer. */
  persistedLineId: string
  itemId: string
  accountId: string
  description: string
  quantity: string
  unit: string
  /** Item id whose alternate unit came from a barcode identifier. */
  scanUnitItemId?: string
  unitPrice: string
  taxProfileId: string
  departmentId: string
  projectId: string
  /** Work period the line bills (sales orders), YYYY-MM-DD or blank. */
  workFrom: string
  workTo: string
  /** Warehouse for fulfil/receipt effects; blank unless the line's item is
   *  stocked. */
  stockLocationId: string
  /** Pricing lineage the line loaded with (client-only, never serialized —
   *  the save payload picks explicit fields). Lets a reopened draft re-send
   *  its stored basis when the row is untouched, instead of nulling it. */
  loadedPrice: { itemId: string; unitPrice: string; quantity: string; basis: PriceBasis } | null
  /** Promotion code carried by a discount line; blank on ordinary lines. */
  promotionCode: string
}
type OrderLineValidationInput = Pick<LineRow, 'itemId' | 'accountId' | 'description' | 'quantity' | 'unitPrice'>

function orderLineIsPopulated(row: OrderLineValidationInput): boolean {
  return Boolean(row.itemId || row.accountId || row.description.trim() || row.quantity.trim() || row.unitPrice.trim())
}

export function findInvalidOrderLine(rows: readonly OrderLineValidationInput[]): { row: number; field: 'quantity' | 'unitPrice' | 'amount' } | null {
  for (const [index, row] of rows.entries()) {
    if (!orderLineIsPopulated(row)) continue
    try {
      if (cmp(row.quantity, '0') <= 0) return { row: index + 1, field: 'quantity' }
    } catch {
      return { row: index + 1, field: 'quantity' }
    }
    try {
      if (cmp(row.unitPrice, '0') < 0) return { row: index + 1, field: 'unitPrice' }
    } catch {
      return { row: index + 1, field: 'unitPrice' }
    }
    try {
      if (cmp(mul(row.quantity, row.unitPrice), '0') <= 0) return { row: index + 1, field: 'amount' }
    } catch {
      return { row: index + 1, field: 'amount' }
    }
  }
  return null
}
interface SegmentOption {
  key: string
  name: string
  showOnHeader: boolean
  showOnLines: boolean
  values: { id: string; name: string }[]
}
interface LinkRow {
  direction: 'from' | 'to'
  link_type: string
  id: string
  kind: string
  document_number: string
  status: string
}
export interface OrderPayload {
  doc: Record<string, unknown>
  lines: Record<string, unknown>[]
  links: LinkRow[]
}

type DropShipRoute = {
  salesOrderLineId: string
  purchaseOrderLineId: string | null
  purchaseOrderId: string | null
}

/** The order header: `documents` plus the loader's joins. Dates, uuids and
 *  numerics arrive from the driver as strings; nullable columns and
 *  left-join columns stay nullable. Column nullability per schema. */
export interface OrderDoc extends Record<string, unknown> {
  id: string
  status: string
  currency: string
  subsidiary_id: string | null
  project_id: string | null
  department_id: string | null
  memo: string | null
  due_date: string | null
  work_completed_on: string | null
  document_date: string | null
  updated_at: string
  subtotal: string
  tax_total: string
  total: string
  party_id: string | null
  party_name: string | null
  document_number: string | null
  extra_dims: Record<string, string | null>
}

/** Narrow the engine loader's untyped document row to the header fields
 *  this drawer reads. Loader rows always carry strings here, so valid
 *  payloads pass through unchanged; anything else falls back to null (or
 *  '' for the NOT NULL columns). */
export function asOrderDoc(raw: Record<string, unknown>): OrderDoc {
  const text = (value: unknown): string | null =>
    typeof value === 'string' ? value : null
  const dims = (value: unknown): Record<string, string | null> => {
    if (!isLineMap(value)) return {}
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, string | null] => entry[1] === null || typeof entry[1] === 'string',
      ),
    )
  }
  return {
    ...raw,
    id: text(raw.id) ?? '',
    status: text(raw.status) ?? '',
    currency: text(raw.currency) ?? '',
    subsidiary_id: text(raw.subsidiary_id),
    project_id: text(raw.project_id),
    department_id: text(raw.department_id),
    memo: text(raw.memo),
    due_date: text(raw.due_date),
    work_completed_on: text(raw.work_completed_on),
    document_date: text(raw.document_date),
    updated_at: text(raw.updated_at) ?? '',
    subtotal: text(raw.subtotal) ?? '0',
    tax_total: text(raw.tax_total) ?? '0',
    total: text(raw.total) ?? '0',
    party_id: text(raw.party_id),
    party_name: text(raw.party_name),
    document_number: text(raw.document_number),
    extra_dims: dims(raw.extra_dims),
  }
}

type DraftSaveResponse = Pick<Response, 'ok' | 'json'>

export async function persistOrderDraft({
  request,
  setState,
  onError,
}: {
  request: () => Promise<DraftSaveResponse>
  setState: (state: 'saving' | 'saved' | 'error') => void
  onError: (message?: string) => void
}): Promise<OrderPayload | null> {
  setState('saving')
  try {
    const response = await request()
    if (!response.ok) {
      const data: unknown = await response.json().catch(() => null)
      const message =
        typeof data === 'object' &&
        data !== null &&
        'error' in data &&
        typeof data.error === 'string'
          ? data.error
          : undefined
      setState('error')
      onError(message)
      return null
    }

    const order = (await response.json()) as OrderPayload
    setState('saved')
    return order
  } catch {
    setState('error')
    onError()
    return null
  }
}

export async function issueSavedOrder({
  persistDraft,
  requestApproval,
}: {
  persistDraft: () => Promise<OrderPayload | null>
  requestApproval: () => Promise<void>
}): Promise<boolean> {
  const saved = await persistDraft()
  if (!saved) return false
  await requestApproval()
  return true
}

const STATUS_VARIANT: Record<string, 'default' | 'success' | 'secondary' | 'warning' | 'outline'> = {
  approved: 'success',
  pending_approval: 'warning',
  draft: 'secondary',
  voided: 'outline',
}

/** Per-kind base list route/param for the flyout close href (wording lives in the catalog, keyed by kind). */
const KIND_META: Record<OrderKind, { base: string; param: string }> = {
  quote: { base: '/estimates', param: 'estimate' },
  sales_order: { base: '/sales-orders', param: 'order' },
  purchase_order: { base: '/purchase-orders', param: 'order' },
}

/** documents.status values with a generic label in common.status (camelCased key). */
const STATUS_LABEL_KEYS = new Set([
  'draft',
  'pendingApproval',
  'approved',
  'rejected',
  'posted',
  'paid',
  'partiallyPaid',
  'open',
  'closed',
  'voided',
  'reversed',
  'cancelled',
])
const toStatusKey = (status: string) => status.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())

/** Where a freshly-created document opens (drawer deep-link per kind). */
function targetHref(kind: string, id: string): string {
  switch (kind) {
    case 'customer_invoice':
      return `/ar/invoices?doc=${id}&mode=edit`
    case 'vendor_bill':
      return `/ap/bills?doc=${id}&mode=edit`
    case 'sales_order':
      return `/sales-orders?order=${id}&mode=edit`
    case 'purchase_order':
      return `/purchase-orders?order=${id}&mode=edit`
    case 'quote':
      return `/estimates?estimate=${id}&mode=edit`
    case 'sales_fulfillment':
      // Fulfilments are immutable evidence on the order they fulfil; the
      // inventory ledger is where their movements are inspected (docHref).
      return '/inventory'
    default:
      return '/'
  }
}

/** Where an existing linked document opens (used by the links section). */
function docHref(kind: string, id: string): string {
  switch (kind) {
    case 'customer_invoice':
      return `/ar/invoices?doc=${id}`
    case 'vendor_bill':
      return `/ap/bills?doc=${id}`
    case 'sales_order':
      return `/sales-orders?order=${id}`
    case 'purchase_order':
      return `/purchase-orders?order=${id}`
    case 'quote':
      return `/estimates?estimate=${id}`
    case 'purchase_receipt':
      // Goods receipts are immutable evidence on the order they receive; the
      // inventory ledger is where their movements are inspected.
      return '/inventory'
    case 'sales_fulfillment':
      return '/inventory'
    case 'pick_list':
      return `/picks?pick=${id}`
    case 'shipment':
      return `/shipments?shipment=${id}`
    default:
      return '/'
  }
}

const emptyLine = (segments: SegmentOption[] = []): LineRow => ({
  clientKey: crypto.randomUUID(),
  persistedLineId: '',
  itemId: '',
  accountId: '',
  description: '',
  quantity: '',
  unit: '',
  unitPrice: '',
  taxProfileId: '',
  departmentId: '',
  projectId: '',
  workFrom: '',
  workTo: '',
  stockLocationId: '',
  loadedPrice: null,
  promotionCode: '',
  ...Object.fromEntries(segments.map((segment) => [`seg_${segment.key}`, INHERIT_SEGMENT])),
})

/** Line text columns are uuids/text-or-null; numerics are handled with String(). */
function lineText(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

function isLineMap(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** Stored pricing lineage for a freshly loaded line: the validated basis plus
 * the item/price/quantity it was stored against. A row that still shows
 * exactly this re-sends the basis; anything touched prices by hand or by a
 * new session resolution. Unparseable lineage loads as none (hand-priced). */
function loadedPriceOf(l: Record<string, unknown>): LineRow['loadedPrice'] {
  const raw = l.price_basis
  const parsed = typeof raw === 'string'
    ? (() => { try { return parsePriceBasis(JSON.parse(raw)) } catch { return null } })()
    : parsePriceBasis(raw ?? null)
  if (!parsed || typeof parsed !== 'object' || 'error' in parsed) return null
  return {
    itemId: lineText(l.item_id),
    unitPrice: l.unit_price != null ? String(l.unit_price) : '',
    quantity: l.quantity != null ? String(l.quantity) : '',
    basis: parsed,
  }
}

/** Project one grid row to its wire shape (no provenance — attached at save
 *  time by withPriceBasis, which sees the live session resolutions). */
function projectLine(r: LineRow, segments: SegmentOption[]): Record<string, unknown> {
  return {
    itemId: r.itemId || null,
    accountId: r.accountId || null,
    description: r.description,
    quantity: r.quantity,
    unit: r.unit || null,
    unitPrice: r.unitPrice,
    taxCodeId: r.taxProfileId.startsWith('code:') ? r.taxProfileId.slice(5) : null,
    taxGroupId: r.taxProfileId.startsWith('group:') ? r.taxProfileId.slice(6) : null,
    departmentId: r.departmentId || null,
    projectId: r.projectId || null,
    workFrom: r.workFrom || null,
    workTo: r.workTo || null,
    stockLocationId: r.stockLocationId || null,
    extraDims: segmentAssignmentsFromCells(r, segments.map(segment => segment.key)),
  }
}

function toRow(l: Record<string, unknown>, segments: SegmentOption[]): LineRow {
  const extraDims = isLineMap(l.extra_dims) ? l.extra_dims : null
  return {
    // Fresh client identity on every load (see the field comment): the
    // grid's React key must be unique among the live rows.
    clientKey: crypto.randomUUID(),
    persistedLineId: lineText(l.id),
    itemId: lineText(l.item_id),
    accountId: lineText(l.account_id),
    description: lineText(l.description),
    quantity: l.quantity != null ? String(l.quantity) : '',
    unit: lineText(l.unit),
    unitPrice: l.unit_price != null ? String(l.unit_price) : '',
    taxProfileId: l.tax_group_id ? `group:${l.tax_group_id}` : l.tax_code_id ? `code:${l.tax_code_id}` : '',
    departmentId: lineText(l.department_id),
    projectId: lineText(l.project_id),
    workFrom: lineText(l.work_from),
    workTo: lineText(l.work_to),
    stockLocationId: lineText(l.stock_location_id),
    loadedPrice: loadedPriceOf(l),
    promotionCode: lineText(l.promotion_code),
    ...Object.fromEntries(segments.map((segment) => [`seg_${segment.key}`, segmentCellValue(extraDims, segment.key)])),
  }
}

export function OrderDrawer({
  order,
  initialMode = 'view',
  kind,
  parties,
  accounts,
  items,
  stockLocations = [],
  taxCodes,
  taxGroups,
  departments,
  projects,
  subsidiaries,
  segments,
  canManage,
  canOverrideCredit = false,
  layout,
  createMode = false,
  closeHref,
  backorders = false,
  pickLists = false,
  returnAuthorizations = false,
  dropShipping = false,
  dropShipLines = [],
  canAssessDropShip = false,
  dropShipLiabilityAccounts = [],
  dropShipVendors = [],
  canRouteDropShip = false,
  canCreateDropShipPurchaseOrder = false,
  canConfirmDropShip = false,
  isDropShipPurchaseOrder = false,
  barcodeScanningEnabled = false,
  customerItemRefs = [],
  promotionsEnabled = false,
  quoteToCashEnabled = false,
  quoteAwardEnabled = false,
}: {
  order: OrderPayload
  initialMode?: DrawerMode
  kind: OrderKind
  parties: Opt[]
  accounts: Opt[]
  items: Opt[]
  /** Active warehouses for the line-level stock-location picker. Empty (or a
   *  single location, stamped silently by the draft writer) renders NO picker. */
  stockLocations?: { id: string; code: string | null }[]
  taxCodes: Opt[]
  taxGroups: Opt[]
  departments: Opt[]
  projects: Opt[]
  subsidiaries: Opt[]
  segments: SegmentOption[]
  canManage: boolean
  /** AR approvers may supply a reasoned credit-limit exception after refusal. */
  canOverrideCredit?: boolean
  layout?: FormLayoutConfig
  /**
   * Unsaved-create: the drawer opens editable on an in-memory payload with
   * no persisted row. Cancel and close navigate away with zero writes; Save
   * persists through one idempotent collection POST. Persisted-record
   * surfaces (issue/convert/void/delete, approvals, attachments, audit)
   * stay hidden until the row exists.
   */
  createMode?: boolean
  /** List URL (filters preserved) that Cancel and the close affordance return to. */
  closeHref?: string
  /** Show the Backorders tab: the page resolved Fulfillment on and the
   *  fulfil-orders permission. The tab's route enforces both again. */
  backorders?: boolean
  /** Offer Create pick list on an issued sales order: the page resolved
   *  Fulfillment on and the fulfil-orders permission. The pick-list form and
   *  its routes enforce both again. */
  pickLists?: boolean
  returnAuthorizations?: boolean
  dropShipping?: boolean
  canAssessDropShip?: boolean
  dropShipLiabilityAccounts?: {id:string;label:string}[]
  dropShipLines?: DropShipRoute[]
  dropShipVendors?: Opt[]
  canRouteDropShip?: boolean
  canCreateDropShipPurchaseOrder?: boolean
  canConfirmDropShip?: boolean
  isDropShipPurchaseOrder?: boolean
  barcodeScanningEnabled?: boolean
  customerItemRefs?: { customerId: string; itemId: string; customerSku: string }[]
  /** Server-known promotions gate for the apply-promotion action and chip. */
  promotionsEnabled?: boolean
  /** Show the quote Subscription tab: the page resolved quoteToCash on.
   *  The tab's routes enforce the feature again. Defaults off so a caller
   *  that never resolves the feature cannot surface a tab that only fails. */
  quoteToCashEnabled?: boolean
  /** Offer Award on an issued quote: the page resolved Projects and Orders
   *  on and the project-management grant. The award route enforces all
   *  three again. */
  quoteAwardEnabled?: boolean
}) {
  const { money } = useMoney()
  const t = useTranslations('purchaseOrders.shared')
  const tEstimates = useTranslations('estimates')
  const tCommon = useTranslations('common')
  const tFulfillment = useTranslations('fulfillment')
  const tReturns = useTranslations('returns')
  const tSales = useTranslations('salesOrders')
  const statusLabel = (status: string) => {
    const key = toStatusKey(String(status))
    return STATUS_LABEL_KEYS.has(key) ? tCommon(`status.${key}`) : String(status).replace('_', ' ')
  }
  const router = useRouter()
  const doc = asOrderDoc(order.doc)
  const meta = KIND_META[kind]
  const isDraft = doc.status === 'draft'
  const isApproved = doc.status === 'approved'
  // Existing records default to read-only; newly created drafts can explicitly
  // request edit mode. Only DRAFT orders
  // are editable (Issue is terminal for the header). Save is EXPLICIT — one Save
  // button, no per-field autosave.
  const canEditStatus = isDraft && canManage
  const [mode, setMode] = useState<DrawerMode>(
    initialDrawerMode(initialMode, canEditStatus),
  )
  // The action hook sits above its first use: editable freezes while busy
  // below, and a later declaration would be a TDZ use-before-assign.
  // Saves, statuses, issues, deletes and converts run on the shared action
  // path: a refusal pins here (role=alert) until the next action — a toast
  // alone never survives attention — AND toasts, and busy always
  // releases through the package's finally.
  const { busy, refusal, execute, refuse, clearRefusal } = useAppAction()
  // Frozen while an action is in flight (the same busy convention the buttons
  // already use): the grid otherwise accepts typing during the save PATCH,
  // and those un-sent edits would be shown as saved and lost on close.
  const editable = mode === 'edit' && canEditStatus && !busy

  const [partyId, setPartyId] = useState<string>(doc.party_id ?? '')
  const [documentDate, setDocumentDate] = useState<string>(doc.document_date ?? '')
  const [dueDate, setDueDate] = useState<string>(doc.due_date ?? '')
  const [workCompletedOn, setWorkCompletedOn] = useState<string>(doc.work_completed_on ?? '')
  const [memo, setMemo] = useState<string>(doc.memo ?? '')
  const [departmentId, setDepartmentId] = useState<string>(doc.department_id ?? '')
  const [projectId, setProjectId] = useState<string>(doc.project_id ?? '')
  const [subsidiaryId, setSubsidiaryId] = useState<string>(doc.subsidiary_id ?? '')
  const [extraDims, setExtraDims] = useState<Record<string, string | null>>(doc.extra_dims ?? {})
  const [rows, setRows] = useState<LineRow[]>(
    order.lines.length > 0 ? order.lines.map((line) => toRow(line, segments)) : [emptyLine(segments)],
  )
  const resolvedPriceRef = useRef(new Map<number, { itemId: string; unitPrice: string; basis: PriceBasis }>())
  const priceRequestRef = useRef(new Map<string, string>())
  const priceRequestSequence = useRef(0)
  // Selling-price lookups that have not settled (pending) or were refused
  // (failures, keyed by row): either blocks Save and Issue until every
  // lookup resolves or the operator corrects the line price — a refused
  // lookup must never post silently at the item default rate.
  const [priceLookupPending, setPriceLookupPending] = useState<Set<string>>(new Set())
  const [priceLookupFailures, setPriceLookupFailures] = useState<Map<string, string>>(new Map())
  const priceLookupBlocked = priceLookupPending.size > 0 || priceLookupFailures.size > 0
  // Row values at response time: a manual edit between request and response
  // supersedes the lookup, so a late failure must neither pin nor overwrite it.
  const latestRowsRef = useRef(rows)
  useLayoutEffect(() => {
    latestRowsRef.current = rows
  })
  const [totals, setTotals] = useState({ subtotal: doc.subtotal, taxTotal: doc.tax_total, total: doc.total })
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'dirty' | 'error'>('saved')
  const [dropShipRoutes, setDropShipRoutes] = useState<DropShipRoute[]>(dropShipLines)
  const [dropShipVendorId, setDropShipVendorId] = useState('')

  // Optimistic-concurrency token (documents.updated_at). Every mutating
  // request echoes it; the server refuses any mutation whose view of the
  // order is not the stored revision. A ref — not state — so a save and the
  // issue that immediately follows it share the exact same revision without
  // waiting on a re-render. The token is opaque microsecond wire form: never
  // round it through Date (toISOString truncates to millis and every
  // mutation fails closed with a 409).
  const revisionOf = (value: unknown) => {
    if (!isDocumentRevisionToken(value)) throw new Error('DOCUMENT_REVISION_REQUIRED')
    return value
  }
  // Unsaved-create has no persisted revision to fence on: the first Save is
  // a collection POST (no token), and every later mutation runs on the
  // persisted id the Save navigates to. The placeholder is never sent — and
  // any revision-fenced request carrying it would fail closed with a 409.
  const revisionRef = useRef<string>(createMode ? '' : revisionOf(doc.updated_at))
  // Stable idempotency key for the create POST, minted once per drawer
  // session: a lost response retried from this drawer replays instead of
  // minting a second order.
  const createKeyRef = useRef<string | null>(null)
  const createKey = () => {
    if (!createKeyRef.current) createKeyRef.current = crypto.randomUUID()
    return createKeyRef.current
  }

  const apiBase = `/api/${
    kind === 'quote' ? 'estimates' : kind === 'sales_order' ? 'sales-orders' : 'purchase-orders'
  }`

  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])
  const taxProfiles = useMemo(() => [
    ...taxCodes.map((profile) => ({ ...profile, value: `code:${profile.id}` })),
    ...taxGroups.map((profile) => ({ ...profile, value: `group:${profile.id}` })),
  ], [taxCodes, taxGroups])
  const taxByProfile = useMemo(() => new Map(taxProfiles.map((profile) => [profile.value, profile.tax_components ?? []])), [taxProfiles])

  const lineAmount = (row: LineRow) => {
    try { return mul(row.quantity || '0', row.unitPrice || '0') } catch { return '0.0000' }
  }
  const lineTax = (row: LineRow) => {
    try { return computeLineTaxes(lineAmount(row), taxByProfile.get(row.taxProfileId) ?? []).taxTotal }
    catch { return '0.0000' }
  }

  /** Converted progress across all lines: billed against the ordered
   *  quantity net of cancellations, which is never billed. */
  const converted = useMemo(() => {
    let ordered = 0n
    let billed = 0n
    for (const l of order.lines) {
      ordered += toUnits(String(l.quantity ?? 0)) - toUnits(String(l.quantity_cancelled ?? 0))
      billed += toUnits(String(l.quantity_billed ?? 0))
    }
    return { ordered: fromUnits(ordered), billed: fromUnits(billed), partial: billed > 0n && billed < ordered, full: ordered > 0n && billed >= ordered }
  }, [order.lines])

  // -- selecting an item defaults description/price/account/tax/unit ----------
  // A row with no lookupable price leaves no lookup state behind: the
  // request (if any) is stale, and a stuck pending entry would block Save
  // long after the row stopped asking.
  const clearPriceLookup = (rowKey: string) => {
    priceRequestRef.current.delete(rowKey)
    setPriceLookupPending((current) => {
      if (!current.has(rowKey)) return current
      const next = new Set(current)
      next.delete(rowKey)
      return next
    })
  }
  const resolveSellingPrice = (index: number, row: LineRow, allRows: LineRow[]) => {
    if (kind === 'purchase_order' || !row.itemId || !row.quantity) {
      clearPriceLookup(row.clientKey)
      return
    }
    let overallItemQuantity: string
    try {
      overallItemQuantity = sum(allRows.filter((candidate) => candidate.itemId === row.itemId).map((candidate) => candidate.quantity || '0'))
      if (cmp(row.quantity, '0') <= 0 || cmp(overallItemQuantity, '0') <= 0) {
        clearPriceLookup(row.clientKey)
        return
      }
    } catch {
      clearPriceLookup(row.clientKey)
      return
    }
    const priceInputs = JSON.stringify({
      itemId: row.itemId,
      customerId: partyId || null,
      currency: doc.currency,
      onDate: documentDate,
      lineQuantity: row.quantity,
      overallItemQuantity,
    })
    const requestIdentity = `${priceInputs}:${++priceRequestSequence.current}`
    priceRequestRef.current.set(row.clientKey, requestIdentity)
    // The response lands asynchronously: bind it to the row and every
    // pricing input, not just the row's former position.
    const rowKey = row.clientKey
    setPriceLookupPending((current) => new Set(current).add(rowKey))
    setPriceLookupFailures((current) => {
      if (!current.has(rowKey)) return current
      const next = new Map(current)
      next.delete(rowKey)
      return next
    })
    clearRefusal()
    void fetchAction<{ price: {
      unitPrice: string
      source: PriceBasis['kind']
      scheduleId: string | null
      priceLevelId: string | null
      assignmentId: string | null
      resolvedAt: string
    } | null }>('/api/items/price', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: priceInputs,
    }).then((result) => {
      if (priceRequestRef.current.get(rowKey) !== requestIdentity) return
      setPriceLookupPending((current) => {
        if (!current.has(rowKey)) return current
        const next = new Set(current)
        next.delete(rowKey)
        return next
      })
      if (!result.ok) {
        // A manually corrected price replaces the failed lookup: pin the
        // failure only while the row still shows exactly what was asked for,
        // so a late refusal never blocks or overwrites a newer line edit.
        const currentRow = latestRowsRef.current.find((candidate) => candidate.clientKey === rowKey)
        if (currentRow?.itemId === row.itemId && currentRow.quantity === row.quantity && currentRow.unitPrice === row.unitPrice) {
          const message = result.error.displayMessage(t('actionFailed'))
          setPriceLookupFailures((current) => new Map(current).set(rowKey, message))
          refuse(message, t('actionFailed'))
        }
        return
      }
      if (!result.data.price) return
      const price = result.data.price
      const basis: PriceBasis = {
        kind: price.source,
        scheduleId: price.scheduleId,
        levelId: price.priceLevelId,
        assignmentId: price.assignmentId,
        unitPrice: price.unitPrice,
        resolvedAt: price.resolvedAt,
      }
      setRows((current) => current.map((candidate, rowIndex) => {
        if (candidate.clientKey !== rowKey || candidate.itemId !== row.itemId || candidate.quantity !== row.quantity) return candidate
        resolvedPriceRef.current.set(rowIndex, { itemId: row.itemId, unitPrice: price.unitPrice, basis })
        return { ...candidate, unitPrice: price.unitPrice }
      }))
    })
  }

  useLayoutEffect(() => {
    for (const [index, tracked] of resolvedPriceRef.current) {
      const row = rows[index]
      if (row?.itemId === tracked.itemId) resolveSellingPrice(index, row, rows)
    }
    rows.forEach((row, index) => {
      if (priceRequestRef.current.has(row.clientKey) && !resolvedPriceRef.current.has(index)) {
        resolveSellingPrice(index, row, rows)
      }
    })
    // Only customer, currency, and pricing date changes re-resolve rows whose
    // price still came from the hierarchy. Row edits are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partyId, doc.currency, documentDate])

  const onRowsChange = (next: LineRow[]) => {
    const prev = rows
    // Match the previous row by client identity: after a reorder, prev[i]
    // is a different line, and comparing against it would "detect" an item
    // change and overwrite the moved line's price/account/tax from defaults.
    const prevByKey = new Map(prev.map((r) => [r.clientKey, r] as const))
    const priorOf = (row: LineRow, i: number): LineRow | undefined =>
      (row.clientKey !== '' ? prevByKey.get(row.clientKey) : undefined) ?? prev[i]
    const merged = next.map((row, i) => {
      if (row.itemId && row.itemId !== priorOf(row, i)?.itemId) {
        const it = itemById.get(row.itemId)
        if (it) {
          return {
            ...row,
            description: row.description || (it.name ?? ''),
            unitPrice: it.default_rate != null ? String(it.default_rate) : row.unitPrice,
            accountId:
              (kind === 'purchase_order' ? it.expense_account_id : it.income_account_id) ?? row.accountId,
            taxProfileId: it.tax_code_id ? `code:${it.tax_code_id}` : row.taxProfileId,
            unit: row.scanUnitItemId === row.itemId ? row.unit : it.unit ?? row.unit,
            quantity: row.quantity || '1',
          }
        }
      }
      return row
    })
    // Position-keyed price tracking goes stale on any membership or order
    // change: drop it so a later resolution can never land on the row that
    // merely inherited the position.
    if (merged.length !== prev.length || merged.some((row, i) => row.clientKey !== prev[i]?.clientKey)) {
      resolvedPriceRef.current.clear()
      const liveKeys = new Set(merged.map((row) => row.clientKey))
      for (const key of priceRequestRef.current.keys()) {
        if (!liveKeys.has(key)) clearPriceLookup(key)
      }
      // A removed row takes its lookup state with it: neither a pending
      // request nor a pinned failure for a deleted line may block Save.
      setPriceLookupFailures((current) => {
        if ([...current.keys()].every((key) => liveKeys.has(key))) return current
        return new Map([...current].filter(([key]) => liveKeys.has(key)))
      })
    }
    setRows(merged)
    merged.forEach((row, index) => {
      const prior = priorOf(row, index)
      const itemChanged = Boolean(row.itemId && row.itemId !== prior?.itemId)
      const tracked = resolvedPriceRef.current.get(index)
      const manuallyChanged = Boolean(prior && row.unitPrice !== prior.unitPrice && !itemChanged)
      if (manuallyChanged) {
        // A hand-entered price replaces whatever the lookup said or would
        // have said: drop the request (its response is now stale) and the
        // row's failure, so the correction unblocks Save.
        resolvedPriceRef.current.delete(index)
        clearPriceLookup(row.clientKey)
        setPriceLookupFailures((current) => {
          if (!current.has(row.clientKey)) return current
          const next = new Map(current)
          next.delete(row.clientKey)
          return next
        })
        clearRefusal()
      }
      const trackedQuantityChanged = Boolean(tracked && tracked.itemId === row.itemId && prior && row.quantity !== prior.quantity && prior.unitPrice === tracked.unitPrice)
      const pendingQuantityChanged = Boolean(priceRequestRef.current.has(row.clientKey) && prior && row.quantity !== prior.quantity)
      if (itemChanged || trackedQuantityChanged || pendingQuantityChanged) resolveSellingPrice(index, row, merged)
    })
  }

  // -- explicit save (no autosave) -------------------------------------------
  const payload = useMemo(
    () => ({
      partyId: partyId || null,
      documentDate: documentDate || undefined,
      dueDate: dueDate || null,
      ...(kind === 'sales_order' ? { workCompletedOn: workCompletedOn || null } : {}),
      memo,
      departmentId: departmentId || null,
      projectId: projectId || null,
      ...(subsidiaries.length > 0 ? { subsidiaryId: subsidiaryId || null } : {}),
      extraDims,
      lines: rows.filter(orderLineIsPopulated).map((r) => projectLine(r, segments)),
    }),
    [partyId, documentDate, dueDate, kind, workCompletedOn, memo, departmentId, projectId, subsidiaryId, subsidiaries.length, extraDims, rows, segments],
  )
  // Track unsaved edits (no autosave — Save is an explicit button). Adjusted
  // during render (same committed value, no extra render).
  const [dirty, setDirty] = useState(false)
  const [prevPayload, setPrevPayload] = useState(payload)
  if (prevPayload !== payload) {
    setPrevPayload(payload)
    if (editable) setDirty(true)
  }
  // Latest committed payload identity for the in-flight-save guard below:
  // async price resolutions can still land while busy (user input is frozen,
  // but fetches are not), and those edits are not in the PATCH body. Written
  // in a layout effect — never during render — and read at save time.
  const latestPayloadRef = useRef(payload)
  useLayoutEffect(() => {
    latestPayloadRef.current = payload
  })
  // Whether the last persist covered the current form. persistDraft sets it;
  // save() reads it to decide between view mode and staying dirty.
  const saveCoveredRef = useRef(true)

  // A dirty editor never closes silently: the X button (via beforeClose)
  // and Cancel both ask first, so typed work survives a stray click.
  async function confirmDiscard() {
    if (mode !== 'edit' || !dirty) return true
    return confirmDialog({
      message: tCommon('feedback.unsavedChanges'),
      confirmLabel: tCommon('confirm.discardChanges'),
      tone: 'danger',
    })
  }

  async function cancelWithConfirm() {
    if (!(await confirmDiscard())) return
    cancel()
  }

  /** Reset every field back to the loaded document (used by Cancel). */
  function resetForm() {
    // Cancel discards the edits the lookups were for: a failure that lands
    // afterwards belongs to discarded rows and must not block Issue from
    // view mode.
    setPriceLookupPending(new Set())
    setPriceLookupFailures(new Map())
    setPartyId(doc.party_id ?? '')
    setDocumentDate(doc.document_date ?? '')
    setDueDate(doc.due_date ?? '')
    setWorkCompletedOn(doc.work_completed_on ?? '')
    setMemo(doc.memo ?? '')
    setDepartmentId(doc.department_id ?? '')
    setProjectId(doc.project_id ?? '')
    setSubsidiaryId(doc.subsidiary_id ?? '')
    setExtraDims(doc.extra_dims ?? {})
    setRows(order.lines.length > 0 ? order.lines.map((line) => toRow(line, segments)) : [emptyLine(segments)])
    setTotals({ subtotal: doc.subtotal, taxTotal: doc.tax_total, total: doc.total })
  }

  /**
   * Provenance for the recorded price basis (0336): attach the preview
   * basis only to rows that still show exactly what the last preview
   * resolved — anything the operator touched afterwards prices by hand
   * (null). A row untouched since load re-sends its stored basis, so a
   * reopened draft does not null its lineage on Save/Issue. Rows the
   * operator re-resolved this session use the session basis.
   *
   * Takes the UNFILTERED grid rows: the session resolutions are keyed by
   * grid position, and filtering first would misalign the lookup onto a
   * neighbour row. Runs at save time (event context), never during render.
   */
  function withPriceBasis(allRows: LineRow[]) {
    return allRows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => orderLineIsPopulated(row))
      .map(({ row, index }) => {
        const session = basisForResolvedRow({ row, resolved: resolvedPriceRef.current.get(index) })
        const loaded = row.loadedPrice
        const stored = loaded
          && row.itemId === loaded.itemId
          && row.unitPrice === loaded.unitPrice
          && row.quantity === loaded.quantity
          ? loaded.basis
          : null
        return { ...projectLine(row, segments), priceBasis: session ?? stored }
      })
  }

  // A line whose selling price never resolved (or was refused) must not
  // post at the item default rate. execute() clears the pinned refusal on
  // entry, so re-pin here rather than relying on the failure-time pin.
  function refuseUnresolvedPriceLookup(): boolean {
    if (!priceLookupBlocked) return false
    if (priceLookupPending.size > 0) refuse(t('pricingResolving'), t('actionFailed'))
    else {
      const first = priceLookupFailures.values().next().value
      if (first) refuse(first, t('actionFailed'))
    }
    return true
  }

  async function persistDraft() {
    if (refuseUnresolvedPriceLookup()) return null
    const sent = payload
    const sentRows = rows
    const saved = await persistOrderDraft({
      request: () => fetch(`${apiBase}/${doc.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...sent, lines: withPriceBasis(sentRows), expectedUpdatedAt: revisionRef.current }),
      }),
      setState: setSaveState,
      // The callback-style helper cannot return its refusal into execute:
      // pin and toast it through the same refusal state instead, so saves
      // and issues share one presentation with every other action.
      onError: (message) => refuse(message, t('actionFailed')),
    })
    if (saved) {
      // Adopt the server's post-save revision so the next mutation (e.g. an
      // issue right after this save) fences on what is actually stored.
      if (saved.doc?.updated_at != null) revisionRef.current = revisionOf(saved.doc.updated_at)
      // The form may have moved after the body was built (an async price
      // resolution landing mid-flight): those edits were never sent, so
      // clearing dirty would show them as saved and lose them on close.
      saveCoveredRef.current = latestPayloadRef.current === sent
      setDirty(!saveCoveredRef.current)
    }
    return saved
  }

  /** Unsaved-create Save: one idempotent collection POST (status=draft).
   *  The document number allocates inside that transaction — nothing before
   *  this call wrote a row or burned a sequence value. */
  async function persistCreate(): Promise<string | null> {
    if (refuseUnresolvedPriceLookup()) return null
    const sentRows = rows
    const saved = await persistOrderDraft({
      request: () => fetch(apiBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': createKey() },
        body: JSON.stringify({ ...payload, lines: withPriceBasis(sentRows) }),
      }),
      setState: setSaveState,
      onError: (message) => refuse(message, t('actionFailed')),
    })
    if (!saved) return null
    const id = (saved.doc as Record<string, unknown> | undefined)?.id
    if (typeof id !== 'string' || id === '') {
      refuse(undefined, t('actionFailed'))
      return null
    }
    return id
  }

  async function save() {
    // persistDraft/persistCreate pin and toast their own refusal through the
    // shared state, so the save reports success-shaped around them: a second
    // pin here would overwrite the specific reason with the generic fallback.
    const invalidLine = findInvalidOrderLine(rows)
    if (invalidLine) {
      const field = invalidLine.field === 'quantity'
        ? t('columns.qty')
        : invalidLine.field === 'unitPrice'
          ? t('columns.unitPrice')
          : tCommon('labels.amount')
      refuse(undefined, t('invalidLineSave', { row: invalidLine.row, field }))
      return
    }
    await execute(async () => {
      if (createMode) {
        const id = await persistCreate()
        if (!id) return { ok: true as const, status: 200, data: null }
        router.push(`${meta.base}?${meta.param}=${id}&mode=edit`)
        router.refresh()
        return { ok: true as const, status: 200, data: null }
      }
      const saved = await persistDraft()
      if (!saved) return { ok: true as const, status: 200, data: null }
      const savedDoc = asOrderDoc(saved.doc)
      setTotals({ subtotal: savedDoc.subtotal, taxTotal: savedDoc.tax_total, total: savedDoc.total })
      if (!saveCoveredRef.current) {
        // Edits landed after the PATCH body was built and were never sent:
        // stay in edit mode, still dirty, so the next Save persists them —
        // switching to view mode would show them as saved and lose them.
        return { ok: true as const, status: 200, data: null }
      }
      setMode('view')
      router.refresh()
      return { ok: true as const, status: 200, data: null }
    }, { fallbackMessage: t('actionFailed') })
  }

  function cancel() {
    // Unsaved-create Cancel writes nothing: there is no row to reset to, so
    // leave by navigation instead of restoring form state.
    if (createMode) {
      clearRefusal()
      router.push(closeHref ?? meta.base)
      return
    }
    resetForm()
    setDirty(false)
    clearRefusal()
    setSaveState('saved')
    setMode('view')
  }

  async function setStatus(
    status: 'approved' | 'voided',
    reason?: string,
    creditOverrideReason?: string,
  ) {
    await execute<{
      doc?: { updated_at?: unknown }
      approvalPending?: boolean
      voidPending?: boolean
    } | { creditOverrideNeeded: true }>(async () => {
      const res = await fetch(`${apiBase}/${doc.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status,
          reason,
          creditOverrideReason,
          expectedUpdatedAt: revisionRef.current,
        }),
      })
      const result = await readActionResult<{
        doc?: { updated_at?: unknown }
        approvalPending?: boolean
        voidPending?: boolean
      }>(res)
      if (
        !result.ok
        && result.error.code === 'CUSTOMER_CREDIT_LIMIT_EXCEEDED'
        && status === 'approved'
        && kind === 'sales_order'
        && canOverrideCredit
        && !creditOverrideReason
      ) {
        // Not a refusal: the override prompt supersedes the pin, so carry a
        // marker through the success path instead of letting execute pin it.
        return { ok: true as const, status: res.status, data: { creditOverrideNeeded: true as const } }
      }
      return result
    }, {
      fallbackMessage: t('actionFailed'),
      onOk: async (data) => {
        if ('creditOverrideNeeded' in data) {
          const overrideReason = await promptDialog({
            title: t('creditOverrideTitle'),
            label: t('creditOverrideReasonLabel'),
            placeholder: t('creditOverrideReasonPlaceholder'),
            confirmLabel: t('creditOverrideConfirm'),
          })
          if (overrideReason) await setStatus(status, reason, overrideReason)
          return
        }
        if (data.doc?.updated_at != null) revisionRef.current = revisionOf(data.doc.updated_at)
        if (data.approvalPending || data.voidPending) {
          toast.success(tCommon('actions.submitForApproval'))
        } else {
          toast.success(status === 'approved' ? t('toastIssued') : t('toastVoided'))
        }
        router.refresh()
      },
    })
  }

  async function issue() {
    // Persist any pending edits first so the server sees the latest lines.
    // persistDraft and setStatus pin and toast their own refusals through the
    // shared state, so the issue reports success-shaped around them: a second
    // pin here would overwrite their specific reason with the generic
    // fallback. Only a helper-shaped throw — a bug, not a refusal — pins.
    await execute(async () => {
      try {
        await issueSavedOrder({
          persistDraft,
          requestApproval: () => setStatus('approved'),
        })
        return { ok: true as const, status: 200, data: null }
      } catch (detail) {
        return {
          ok: false as const,
          error: new ActionError({
            kind: 'unexpected',
            serverMessage: null,
            detail: detail instanceof Error ? detail.message : String(detail),
          }),
        }
      }
    }, { fallbackMessage: t('actionFailed') })
  }

  async function voidOrder() {
    if (
      !(await confirmDialog({
        title: t('voidConfirmTitle'),
        message: t('voidConfirmMessage'),
        confirmLabel: tCommon('actions.void'),
        tone: 'danger',
      }))
    )
      return
    const reason = await promptDialog({
      title: tCommon('amendment.voidTitle'),
      label: tCommon('amendment.reason'),
      placeholder: tCommon('amendment.voidPlaceholder'),
      confirmLabel: tCommon('actions.void'),
    })
    if (!reason) return
    await setStatus('voided', reason)
  }

  async function setDropShipRoute(salesOrderLineId: string, routed: boolean) {
    await execute(
      () => fetchAction(`/api/sales-orders/${doc.id}/drop-ship`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ salesOrderLineId, routed }),
      }),
      {
        fallbackMessage: t('actionFailed'),
        onOk: () => {
          setDropShipRoutes((current) => routed
            ? [...current.filter((row) => row.salesOrderLineId !== salesOrderLineId), {
                salesOrderLineId,
                purchaseOrderLineId: null,
                purchaseOrderId: null,
              }]
            : current.filter((row) => row.salesOrderLineId !== salesOrderLineId))
          toast.success(routed ? t('dropShip.routed') : t('dropShip.unrouted'))
        },
      },
    )
  }

  async function createDropShipPurchaseOrder() {
    if (!dropShipVendorId) return
    const key = crypto.randomUUID()
    await execute<{ id: string; documentNumber: string }>(
      () => fetchAction(`/api/sales-orders/${doc.id}/drop-ship/purchase-orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify({ vendorId: dropShipVendorId }),
      }),
      {
        fallbackMessage: t('actionFailed'),
        onOk: (created) => {
          toast.success(t('dropShip.purchaseOrderCreated', { number: created.documentNumber }))
          router.push(`/purchase-orders?order=${encodeURIComponent(created.id)}`)
          router.refresh()
        },
      },
    )
  }

  async function confirmDropShipShipment() {
    const paired = new Set(dropShipRoutes
      .filter((row) => row.purchaseOrderLineId && row.purchaseOrderId === doc.id)
      .map((row) => row.purchaseOrderLineId!))
    const lines = order.lines.flatMap((line) => {
      const id = String(line.id ?? '')
      if (!paired.has(id)) return []
      const open = toQuantityUnits(String(line.quantity ?? '0'))
        - toQuantityUnits(String(line.quantity_fulfilled ?? '0'))
        - toQuantityUnits(String(line.quantity_cancelled ?? '0'))
      return open > 0n ? [{ purchaseOrderLineId: id, quantity: fromQuantityUnits(open) }] : []
    })
    if (lines.length === 0) return
    if (!(await confirmDialog({
      title: t('dropShip.confirmTitle'),
      message: t('dropShip.confirmAllMessage', { count: lines.length }),
      confirmLabel: t('dropShip.confirm'),
    }))) return
    await execute<{ salesFulfillment: { documentNumber: string } }>(
      () => fetchAction(`/api/purchase-orders/${doc.id}/drop-ship-confirmation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ lines }),
      }),
      {
        fallbackMessage: t('actionFailed'),
        onOk: (result) => {
          toast.success(t('dropShip.confirmed', { number: result.salesFulfillment.documentNumber }))
          router.refresh()
        },
      },
    )
  }

  async function remove() {
    if (
      !(await confirmDialog({
        title: t('deleteConfirmTitle'),
        message: t('deleteConfirmMessage'),
        confirmLabel: tCommon('actions.delete'),
        tone: 'danger',
      }))
    )
      return
    await execute(
      () =>
        fetchAction(`${apiBase}/${doc.id}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expectedUpdatedAt: revisionRef.current }),
        }),
      {
        fallbackMessage: t('actionFailed'),
        successMessage: t('toastDeleted'),
        onOk: () => {
          router.push(meta.base)
          router.refresh()
        },
      },
    )
  }

  async function convert(
    targetKind: string,
    label: string,
    creditOverrideReason?: string,
  ) {
    await execute<{
      kind: string
      id: string
      documentNumber: string
    } | { creditOverrideNeeded: true }>(async () => {
      const res = await fetch(`${apiBase}/${doc.id}/convert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetKind,
          creditOverrideReason,
          expectedUpdatedAt: revisionRef.current,
        }),
      })
      const result = await readActionResult<{
        kind: string
        id: string
        documentNumber: string
      }>(res)
      if (
        !result.ok
        && result.error.code === 'CUSTOMER_CREDIT_LIMIT_EXCEEDED'
        && targetKind === 'sales_order'
        && canOverrideCredit
        && !creditOverrideReason
      ) {
        // Not a refusal: the override prompt supersedes the pin, so carry a
        // marker through the success path instead of letting execute pin it.
        return { ok: true as const, status: res.status, data: { creditOverrideNeeded: true as const } }
      }
      return result
    }, {
      fallbackMessage: t('convertFailed'),
      onOk: async (data) => {
        if ('creditOverrideNeeded' in data) {
          const overrideReason = await promptDialog({
            title: t('creditOverrideTitle'),
            label: t('creditOverrideReasonLabel'),
            placeholder: t('creditOverrideReasonPlaceholder'),
            confirmLabel: t('creditOverrideConfirm'),
          })
          if (overrideReason) await convert(targetKind, label, overrideReason)
          return
        }
        toast.success(t('convertCreated', { target: label, number: data.documentNumber }))
        router.push(targetHref(data.kind, data.id))
        router.refresh()
      },
    })
  }

  // -- line warehouse picker ------------------------------------
  // Stocked lines relieve a warehouse at fulfil/receipt/posting, so an order
  // line for stocked goods must name one. The picker appears only when the
  // choice is real (several active locations) and only on stocked rows; a
  // single location is stamped silently by the draft writer instead.
  const stockedItemIds = useMemo(
    () => new Set(items.filter((item) => item.has_inventory_profile === true).map((item) => item.id)),
    [items],
  )
  const customerSkuByItem = useMemo(() => new Map(
    customerItemRefs.filter((ref) => ref.customerId === partyId).map((ref) => [ref.itemId, ref.customerSku]),
  ), [customerItemRefs, partyId])
  const warehouseColumn = useMemo<LineGridColumn<LineRow> | null>(() => {
    if (stockLocations.length < 2) return null
    if (!rows.some((row) => row.itemId !== '' && stockedItemIds.has(row.itemId))) return null
    return {
      key: 'stockLocationId',
      label: tCommon('labels.warehouse'),
      width: '150px',
      type: 'select',
      options: [{ value: '', label: '—' }, ...stockLocations.map((l) => ({ value: l.id, label: l.code ?? '' }))],
      isCellEditable: (row) => stockedItemIds.has(String(row.itemId ?? '')),
    }
  }, [stockLocations, rows, stockedItemIds, tCommon])

  // Discount lines applied from a promotion carry its code; the column shows
  // only when a row actually carries one, so ordinary orders keep their grid.
  const promotionColumn = useMemo<LineGridColumn<LineRow> | null>(() => {
    if (!(promotionsEnabled && (kind === 'quote' || kind === 'sales_order'))) return null
    if (!rows.some((row) => row.promotionCode !== '')) return null
    return {
      key: 'promotionCode',
      label: tSales('promotion.chip'),
      width: '130px',
      type: 'readonly',
      render: (row) => {
        const code = String(row.promotionCode ?? '')
        if (code === '') return null
        return <Badge variant="secondary">{code}</Badge>
      },
    }
  }, [promotionsEnabled, kind, rows, tSales])

  // -- grid columns ----------------------------------------------------------
  const columns = useMemo<LineGridColumn<LineRow>[]>(
    () => {
      const builtIn: Record<string, LineGridColumn<LineRow>> = {
      item_id:
      {
        key: 'itemId',
        label: t('columns.item'),
        width: 'minmax(170px,1.6fr)',
        type: 'search-select',
        options: items.map((i) => {
          const base = `${i.code ? i.code + ' · ' : ''}${i.name ?? ''}`.trim()
          const customerSku = customerSkuByItem.get(i.id)
          return { value: i.id, label: customerSku ? `${base} · ${customerSku}` : base }
        }),
        scanResolver: optionalScanResolver(barcodeScanningEnabled, (value) => ({
          field: 'item', value, customerId: partyId || undefined,
        })),
        onScanResolved: (_row, _index, result) => result.unit
          ? { unit: result.unit, scanUnitItemId: result.value }
          : undefined,
        placeholder: '—',
      },
      account_id: {
        key: 'accountId',
        label: t('columns.account', { kind }),
        width: 'minmax(180px,1.8fr)',
        type: 'search-select',
        options: accounts.map((a) => ({ value: a.id, label: `${a.number ?? ''} ${a.name ?? ''}`.trim() })),
        placeholder: t('columns.accountPlaceholder'),
      },
      description: { key: 'description', label: tCommon('labels.description'), width: 'minmax(150px,1.6fr)', type: 'text' },
      quantity: { key: 'quantity', label: t('columns.qty'), width: '90px', type: 'decimal', decimalScale: 8, align: 'right', required: true },
      unit: { key: 'unit', label: tCommon('labels.unit'), width: '90px', type: 'text' },
      unit_price: { key: 'unitPrice', label: t('columns.unitPrice'), width: '110px', type: 'decimal', decimalScale: 8, align: 'right', required: true },
      department_id: {
        key: 'departmentId', label: tCommon('labels.department'), width: '140px', type: 'select',
        options: [{ value: '', label: '—' }, ...departments.map((department) => ({ value: department.id, label: department.name ?? '' }))],
      },
      project_id: {
        key: 'projectId', label: tCommon('labels.project'), width: 'minmax(150px,1.2fr)', type: 'search-select',
        options: projects.map((project) => ({ value: project.id, label: project.name ?? '' })), placeholder: '—',
      },
      work_from: { key: 'workFrom', label: tCommon('labels.workFrom'), width: '130px', type: 'text', placeholder: 'YYYY-MM-DD' },
      work_to: { key: 'workTo', label: tCommon('labels.workTo'), width: '130px', type: 'text', placeholder: 'YYYY-MM-DD' },
      tax_code_id: {
        key: 'taxProfileId',
        label: tCommon('labels.tax'),
        width: '110px',
        type: 'select',
        options: [{ value: '', label: t('columns.noTax') }, ...taxProfiles.map((profile) => ({ value: profile.value, label: profile.code ?? '' }))],
      },
      amount: {
        key: '_amount',
        label: tCommon('labels.amount'),
        width: '120px',
        type: 'readonly',
        align: 'right',
        render: (row) => {
          const a = lineAmount(row)
          return a ? money(a, { currency: doc.currency }) : ''
        },
      },
      tax_amount: {
        key: '_tax',
        label: t('columns.taxAmount'),
        width: '100px',
        type: 'readonly',
        align: 'right',
        render: (row) => {
          const t = lineTax(row)
          return t ? money(t, { currency: doc.currency }) : ''
        },
      },
      }
      // The work period is opt-in through the form designer: without a
      // layout it stays off the grid.
      const placed = !layout ? Object.entries(builtIn).filter(([key]) => key !== 'work_from' && key !== 'work_to').map(([, column]) => column) : layout.lines.columns.flatMap((placement) => {
        if (!placement.visible) return []
        const base = builtIn[placement.key]
        if (!base) return []
        return [{ ...base, width: placement.width ?? base.width, label: placement.labelOverride?.trim() || base.label }]
      })
      return [
        ...placed,
        // The warehouse picker is force-shown like a mandatory dimension:
        // tenant layouts predate the key, so placement alone would hide it.
        ...(warehouseColumn ? [warehouseColumn] : []),
        ...(promotionColumn ? [promotionColumn] : []),
        ...(dropShipping && kind === 'sales_order' && isApproved ? [{
          key: '_dropShip',
          label: t('dropShip.routedLines'),
          width: 'minmax(170px,1fr)',
          type: 'readonly' as const,
          render: (row: LineRow) => {
            if (!row.persistedLineId || !stockedItemIds.has(row.itemId)) return null
            const route = dropShipRoutes.find((candidate) => candidate.salesOrderLineId === row.persistedLineId)
            return (
              <span className="flex flex-wrap items-center gap-2 text-sm">
                {route?.purchaseOrderId ? (
                  <Link className="font-mono text-teal-700 hover:underline dark:text-teal-300" href={`/purchase-orders?order=${encodeURIComponent(route.purchaseOrderId)}`}>
                    {t('dropShip.purchaseOrderLinked')}
                  </Link>
                ) : route ? <span className="text-slate-500 dark:text-slate-400">{t('dropShip.routed')}</span> : null}
                {canRouteDropShip && !route ? (
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => setDropShipRoute(row.persistedLineId, true)}>{t('dropShip.routeLine')}</Button>
                ) : null}
                {canRouteDropShip && route && !route.purchaseOrderLineId ? (
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => setDropShipRoute(row.persistedLineId, false)}>{t('dropShip.unrouteLine')}</Button>
                ) : null}
              </span>
            )
          },
        }] : []),
        ...segments.filter((segment) => segment.showOnLines).map((segment): LineGridColumn<LineRow> => ({
          key: `seg_${segment.key}`,
          label: segment.name,
          width: 'minmax(150px,1.2fr)',
          type: 'search-select',
          options: [{ value: INHERIT_SEGMENT, label: tCommon('labels.inheritHeader') }, { value: CLEAR_SEGMENT, label: tCommon('labels.noDimensionValue') }, ...segment.values.map((value) => ({ value: value.id, label: value.name }))],
          placeholder: '—',
        })),
      ]
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accounts, items, taxProfiles, departments, projects, segments, kind, layout, t, tCommon, warehouseColumn, promotionColumn, customerSkuByItem, barcodeScanningEnabled, partyId, dropShipping, isApproved, stockedItemIds, dropShipRoutes, canRouteDropShip, busy],
  )

  const field = 'space-y-1.5'
  const renderHeaderField = (placement: HeaderFieldPlacement, isEditable: boolean) => {
    const label = placement.labelOverride?.trim()
    switch (placement.key) {
      case 'party_id':
        return <><FieldLabel fieldName={label || t('partyLabel', { kind })}>{label || t('partyLabel', { kind })}{isEditable ? <span className="text-red-500"> *</span> : null}</FieldLabel>{isEditable ? <SearchSelect options={parties.map((party) => ({ value: party.id, label: party.display_name ?? '' }))} value={partyId} onChange={(value) => setPartyId(value ?? '')} placeholder={t('selectPartyPlaceholder', { kind })} /> : <p className="text-sm">{doc.party_name ?? '—'}</p>}</>
      case 'document_date':
        return <><FieldLabel fieldName={label || t('dateLabel', { kind })}>{label || t('dateLabel', { kind })}</FieldLabel>{isEditable ? <Input type="date" value={documentDate} onChange={(event) => setDocumentDate(event.target.value)} /> : <p className="text-sm">{doc.document_date}</p>}</>
      case 'due_date':
        return <><FieldLabel fieldName={label || t('expiryLabel', { kind })}>{label || t('expiryLabel', { kind })}</FieldLabel>{isEditable ? <Input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} /> : <p className="text-sm">{doc.due_date ?? '—'}</p>}</>
      case 'work_completed_on':
        if (kind !== 'sales_order') return null
        return <><FieldLabel fieldName={label || tCommon('labels.workCompletedOn')}>{label || tCommon('labels.workCompletedOn')}</FieldLabel>{isEditable ? <Input type="date" value={workCompletedOn} onChange={(event) => setWorkCompletedOn(event.target.value)} /> : <p className="text-sm">{doc.work_completed_on ?? '—'}</p>}</>
      case 'department_id':
        return <><FieldLabel fieldName={label || tCommon('labels.department')}>{label || tCommon('labels.department')}</FieldLabel>{isEditable ? <SearchSelect options={[{ value: '', label: '—' }, ...departments.map((department) => ({ value: department.id, label: department.name ?? '' }))]} value={departmentId} onChange={(value) => setDepartmentId(value ?? '')} placeholder="—" /> : <p className="text-sm">{departments.find((department) => department.id === doc.department_id)?.name ?? '—'}</p>}</>
      case 'project_id':
        return <><FieldLabel fieldName={label || tCommon('labels.project')}>{label || tCommon('labels.project')}</FieldLabel>{isEditable ? <SearchSelect options={[{ value: '', label: '—' }, ...projects.map((project) => ({ value: project.id, label: project.name ?? '' }))]} value={projectId} onChange={(value) => setProjectId(value ?? '')} placeholder="—" /> : <p className="text-sm">{projects.find((project) => project.id === doc.project_id)?.name ?? '—'}</p>}</>
      case 'subsidiary_id':
        if (subsidiaries.length === 0) return null
        return <><FieldLabel fieldName={label || tCommon('labels.subsidiary')}>{label || tCommon('labels.subsidiary')}</FieldLabel>{isEditable ? <SearchSelect options={subsidiaries.map((subsidiary) => ({ value: subsidiary.id, label: subsidiary.name ?? '' }))} value={subsidiaryId} onChange={(value) => setSubsidiaryId(value ?? '')} placeholder="—" clearable /> : <p className="text-sm">{subsidiaries.find((subsidiary) => subsidiary.id === doc.subsidiary_id)?.name ?? '—'}</p>}</>
      case 'memo':
        return <><FieldLabel fieldName={label || tCommon('labels.memo')}>{label || tCommon('labels.memo')}</FieldLabel>{isEditable ? <Input value={memo} onChange={(event) => setMemo(event.target.value)} /> : <p className="text-sm">{doc.memo ?? '—'}</p>}</>
      default:
        return null
    }
  }
  const canIssue = !priceLookupBlocked && !!partyId && rows.some((r) => {
    try { return Boolean(r.itemId || r.accountId) && cmp(lineAmount(r), '0') > 0 } catch { return false }
  })
  const convertTargets = CONVERSION_TARGETS[kind]

  return (
    <TransactionDrawer
      closeHref={closeHref ?? meta.base}
      beforeClose={confirmDiscard}
      recordId={createMode ? 'new' : String(doc.id)}
      canEditAttachments={createMode ? false : canManage}
      panelClassName={docTypeMeta(kind).surfaceCls}
      // Attachments, audit, and approvals all read the persisted row the
      // unsaved drawer has not written yet — hide them until it exists.
      showEvidenceTabs={createMode ? false : undefined}
      title={
        <span className="flex items-center gap-2.5">
          <DocTypeBadge kind={kind} />
          {doc.document_number ? <span className="font-mono">{doc.document_number}</span> : null}
          <Badge variant={STATUS_VARIANT[doc.status] ?? 'secondary'}>
            {statusLabel(doc.status)}
          </Badge>
          <ExternalRefChip externalRef={doc.external_ref} externalSource={doc.external_source} />
          {converted.partial ? (
            <span className="text-xs font-normal text-slate-500 dark:text-slate-400">
              {t('convertedProgress', {
                billed: converted.billed,
                ordered: converted.ordered,
              })}
            </span>
          ) : converted.full ? (
            <span className="text-xs font-normal text-emerald-600 dark:text-emerald-400">{t('fullyConverted')}</span>
          ) : null}
        </span>
      }
      description={mode === 'edit' ? tCommon('feedback.editingHint') : (doc.party_name ?? undefined)}
      primaryAction={
        canManage && canEditStatus ? (
          <Button variant="outline" size="sm" className="h-8 px-2.5 text-xs" disabled={busy} onClick={() => mode === 'edit' ? cancelWithConfirm() : setMode('edit')}>
            {mode === 'edit' ? tCommon('actions.cancel') : tCommon('actions.edit')}
          </Button>
        ) : null
      }
      actions={
        mode === 'edit' ? (
          <>
            <Button disabled={busy || priceLookupBlocked} onClick={save} title={priceLookupPending.size > 0 ? t('pricingResolving') : undefined}>
              {busy ? tCommon('actions.saving') : tCommon('actions.save')}
            </Button>
          </>
        ) : (canManage || canCreateDropShipPurchaseOrder || canConfirmDropShip || (kind === 'quote' && quoteAwardEnabled)) ? (
          <>
            {kind === 'quote' && quoteAwardEnabled && !createMode ? (
              <QuoteAwardAction quoteId={String(doc.id)} docStatus={doc.status} />
            ) : null}
            {canManage ? (
              <>
                <PdfButton recordType={kind} recordId={String(doc.id)} />
                <SendButton recordType={kind} recordId={String(doc.id)} />
                <FlowManualButtons subjectKind={kind} subjectId={String(doc.id)} />
                <ApprovalActions subjectKind={kind} subjectId={String(doc.id)} />
                {isDraft ? (
                  <Button disabled={busy || !canIssue} onClick={issue} title={priceLookupBlocked ? t('pricingResolving') : !canIssue ? t('issueHint') : undefined}>
                    {t('issue')}
                  </Button>
                ) : null}
                {isApproved
                  ? convertTargets.map((target) => (
                      <Button
                        key={target.kind}
                        disabled={busy || converted.full}
                        title={converted.full ? t('fullyConverted') : undefined}
                        onClick={() => convert(target.kind, t(target.labelKey))}
                      >
                        {t('convertTo', { target: t(target.labelKey) })}
                      </Button>
                    ))
                  : null}
                {pickLists && kind === 'sales_order' && isApproved ? (
                  <Button disabled={busy} onClick={() => router.push(`/picks?pickFrom=${encodeURIComponent(String(doc.id))}`)}>
                    {tFulfillment('pick.createFromOrder')}
                  </Button>
                ) : null}
              </>
            ) : null}
            {dropShipping && canAssessDropShip && kind==='sales_order' && isApproved && dropShipRoutes.some(route=>route.purchaseOrderLineId) ?
              <DropShipAssessmentButton lines={dropShipRoutes.filter(route=>route.purchaseOrderLineId).map(route=>({id:route.salesOrderLineId,label:String(order.lines.find(line=>line.id===route.salesOrderLineId)?.description || route.salesOrderLineId)}))} accounts={dropShipLiabilityAccounts} /> : null}
            {dropShipping && canCreateDropShipPurchaseOrder && kind === 'sales_order' && isApproved
              && dropShipRoutes.some((row) => row.purchaseOrderLineId === null) ? (
              <div className="flex items-center gap-2">
                <SearchSelect
                  options={dropShipVendors.map((vendor) => ({ value: vendor.id, label: vendor.display_name ?? '' }))}
                  value={dropShipVendorId}
                  onChange={(value) => setDropShipVendorId(value ?? '')}
                  placeholder={t('dropShip.selectVendor')}
                />
                <Button disabled={busy || !dropShipVendorId} onClick={createDropShipPurchaseOrder}>
                  {t('dropShip.createPurchaseOrder')}
                </Button>
              </div>
            ) : null}
            {dropShipping && canConfirmDropShip && isDropShipPurchaseOrder && isApproved ? (
              <Button disabled={busy} onClick={confirmDropShipShipment}>
                {t('dropShip.confirmVendorShipment')}
              </Button>
            ) : null}
            {returnAuthorizations && kind === 'sales_order' && isApproved ? (
              <Button variant="outline" disabled={busy} onClick={() => router.push(`/returns?doc=new&kind=rma&sourceDocumentId=${encodeURIComponent(String(doc.id))}`)}>
                {tReturns('actions.new')}
              </Button>
            ) : null}
            {canManage && isApproved ? (
              <Button variant="outline" disabled={busy} onClick={voidOrder}>
                {tCommon('actions.void')}
              </Button>
            ) : null}
            {canManage && doc.status === 'draft' ? (
              <Button variant="ghost" disabled={busy} onClick={remove} className="text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950/40">
                {tCommon('actions.delete')}
              </Button>
            ) : null}
          </>
        ) : null
      }
      keepRecordTabsMounted={['subscription']}
      detailTabs={createMode ? [] : [
        ...(order.links.length > 0 ? [{
          key: 'related',
          label: t('linksTitle'),
          content: (
            <div className="space-y-2">
              <Label>{t('linksTitle')}</Label>
              <div className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
                {order.links.map((l) => (
                  <div key={`${l.direction}-${l.id}`} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <span className="w-28 shrink-0 text-xs font-medium text-slate-500 dark:text-slate-400">
                      {l.direction === 'from' ? t('linkCreatedFrom') : t('linkConvertedInto')}
                    </span>
                    <Link
                      href={docHref(l.kind, l.id)}
                      className="font-mono text-teal-700 hover:underline dark:text-teal-300"
                    >
                      {l.document_number}
                    </Link>
                    <span className="text-slate-400 dark:text-slate-500">{t('docKind', { kind: l.kind })}</span>
                    <span className="flex-1" />
                    <Badge variant={STATUS_VARIANT[l.status] ?? 'secondary'}>
                      {statusLabel(l.status)}
                    </Badge>
                  </div>
                ))}
              </div>
            </div>
          ),
        }] : []),
        {
          key: 'approvals',
          label: tCommon('approvalFlow.historyTitle'),
          content: <ApprovalHistory subjectKind={kind} subjectId={String(doc.id)} showEmptyState />,
        },
        ...(kind === 'quote' && quoteToCashEnabled ? [{
          key: 'subscription',
          label: tEstimates('quoteCash.tab'),
          content: (
            <QuoteCashSection
              quoteId={String(doc.id)}
              currency={doc.currency}
              canManage={canManage}
              docStatus={doc.status}
              lines={order.lines
                .filter((l) => typeof (l as { id?: unknown }).id === 'string')
                .map((l) => ({
                  id: (l as unknown as { id: string }).id,
                  description: typeof l.description === 'string' ? l.description : null,
                }))}
            />
          ),
        }] : []),
        ...(backorders && kind === 'sales_order' && isApproved ? [{
          key: 'backorders',
          label: t('backorders.tab'),
          content: (
            <OrderBackorders
              orderId={String(doc.id)}
              itemLabel={(itemId) => {
                const item = itemById.get(itemId)
                return item ? `${item.code ? `${item.code} · ` : ''}${item.name ?? ''}` : '—'
              }}
            />
          ),
        }] : []),
      ]}
      footer={
        <div className="flex w-full items-center gap-3">
          <span role="status" className="sr-only">{priceLookupPending.size > 0 ? t('pricingResolving') : null}</span>
          <span
            className={
              'text-xs ' +
              (saveState === 'error' ? 'text-red-600 dark:text-red-400' : 'text-slate-500 dark:text-slate-400')
            }
          >
            {mode === 'edit'
              ? saveState === 'saving'
                ? tCommon('actions.saving')
                : saveState === 'error'
                  ? t('saveFailedRetry')
                  : dirty
                    ? t('unsavedChanges')
                    : null
              : null}
          </span>
          <span className="flex-1" />
          <span className="text-sm text-slate-600 tabular-nums dark:text-slate-300">
            {t('totals.subtotal', { amount: money(totals.subtotal, { currency: doc.currency }) })} ·{' '}
            {t('totals.tax', { amount: money(totals.taxTotal, { currency: doc.currency }) })} ·{' '}
            <strong className="text-slate-900 dark:text-slate-100">
              {t('totals.total', { amount: money(totals.total, { currency: doc.currency }) })}
            </strong>
          </span>
        </div>
      }
    >
      <div className="space-y-6 p-1">
        <ActionAlert error={refusal} fallbackMessage={t('actionFailed')} />
        {priceLookupFailures.size > 0 ? <ul className="space-y-1 text-sm text-red-700 dark:text-red-300">{[...priceLookupFailures].map(([key, message]) => <li key={key} role="alert">{rows.find((row) => row.clientKey === key)?.description || t('columns.item')}: {message}</li>)}</ul> : null}
        {layout ? <HeaderFields layout={layout} editable={editable} renderField={renderHeaderField} /> : <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className={`${field} lg:col-span-2`}>
            <Label>
              {t('partyLabel', { kind })}
              {editable ? <span className="text-red-500"> *</span> : null}
            </Label>
            {editable ? (
              <SearchSelect
                options={parties.map((c) => ({ value: c.id, label: c.display_name ?? '' }))}
                value={partyId}
                onChange={(v) => setPartyId(v ?? '')}
                placeholder={t('selectPartyPlaceholder', { kind })}
              />
            ) : (
              <p className="text-sm">{doc.party_name ?? '—'}</p>
            )}
          </div>
          <div className={field}>
            <Label>{t('dateLabel', { kind })}</Label>
            {editable ? (
              <Input type="date" value={documentDate} onChange={(e) => setDocumentDate(e.target.value)} />
            ) : (
              <p className="text-sm">{doc.document_date}</p>
            )}
          </div>
          <div className={field}>
            <Label>{t('expiryLabel', { kind })}</Label>
            {editable ? (
              <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            ) : (
              <p className="text-sm">{doc.due_date ?? '—'}</p>
            )}
          </div>
          <div className={field}>
            <Label>{tCommon('labels.department')}</Label>
            {editable ? (
              <SearchSelect
                options={[{ value: '', label: '—' }, ...departments.map((d) => ({ value: d.id, label: d.name ?? '' }))]}
                value={departmentId}
                onChange={(v) => setDepartmentId(v ?? '')}
                placeholder="—"
              />
            ) : (
              <p className="text-sm">{departments.find((d) => d.id === doc.department_id)?.name ?? '—'}</p>
            )}
          </div>
          <div className={field}>
            <Label>{tCommon('labels.project')}</Label>
            {editable ? (
              <SearchSelect
                options={[{ value: '', label: '—' }, ...projects.map((p) => ({ value: p.id, label: p.name ?? '' }))]}
                value={projectId}
                onChange={(v) => setProjectId(v ?? '')}
                placeholder="—"
              />
            ) : (
              <p className="text-sm">{projects.find((p) => p.id === doc.project_id)?.name ?? '—'}</p>
            )}
          </div>
          {subsidiaries.length > 0 ? (
            <div className={field}>
              <Label>{tCommon('labels.subsidiary')}</Label>
              {editable ? (
                <SearchSelect
                  options={subsidiaries.map((subsidiary) => ({ value: subsidiary.id, label: subsidiary.name ?? '' }))}
                  value={subsidiaryId}
                  onChange={(value) => setSubsidiaryId(value ?? '')}
                  placeholder="—"
                  clearable
                />
              ) : (
                <p className="text-sm">{subsidiaries.find((subsidiary) => subsidiary.id === doc.subsidiary_id)?.name ?? '—'}</p>
              )}
            </div>
          ) : null}
          <div className={`${field} lg:col-span-2`}>
            <Label>{tCommon('labels.memo')}</Label>
            {editable ? (
              <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
            ) : (
              <p className="text-sm">{doc.memo ?? '—'}</p>
            )}
          </div>
        </div>}

        {segments.some((segment) => segment.showOnHeader) ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {segments.filter((segment) => segment.showOnHeader).map((segment) => {
              const selected = extraDims[segment.key] ?? ''
              return (
                <div key={segment.key} className={field}>
                  <Label>{segment.name}</Label>
                  {editable ? (
                    <SearchSelect
                      options={segment.values.map((value) => ({ value: value.id, label: value.name }))}
                      value={selected}
                      onChange={(value) => setExtraDims((current) => ({ ...current, [segment.key]: value || null }))}
                      placeholder="—"
                      clearable
                    />
                  ) : (
                    <p className="text-sm">{segment.values.find((value) => value.id === selected)?.name ?? '—'}</p>
                  )}
                </div>
              )
            })}
          </div>
        ) : null}

        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Label>{tCommon('labels.lines')}</Label>
            {promotionsEnabled && (kind === 'quote' || kind === 'sales_order') && editable && !createMode && doc.id !== '' && doc.status === 'draft' ? (
              <PromotionApplyControl documentId={doc.id} currency={doc.currency} onApplied={() => router.refresh()} />
            ) : null}
          </div>
          <LineGrid<LineRow>
            columns={columns}
            rows={rows}
            onRowsChange={onRowsChange}
            emptyRow={() => emptyLine(segments)}
            getRowKey={(row, i) => row.clientKey !== '' ? row.clientKey : `row-${i}`}
            cloneRow={(row) => ({ ...row, clientKey: crypto.randomUUID(), persistedLineId: '' })}
            readOnly={!editable}
            formatAmount={(value) => money(value, { currency: doc.currency })}
          />
        </div>
      </div>
    </TransactionDrawer>
  )
}

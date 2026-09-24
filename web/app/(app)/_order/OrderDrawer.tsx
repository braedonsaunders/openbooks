'use client'

import { useMoney } from '@/components/money-provider'
import { initialDrawerMode, type DrawerMode } from '@/lib/drawer-mode'
import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { ActionError, fetchAction, readActionResult } from '@braedonsaunders/appkit-errors'
import { ActionAlert } from '@braedonsaunders/appkit-errors/react'
import { useAppAction } from '@/lib/use-app-action'
import { basisForResolvedRow, type PriceBasis } from '@/lib/price-basis'
import { Badge, Button, FieldLabel, Input, Label, SearchSelect } from '@openbooks/ui'
import { LineGrid, type LineGridColumn } from '../../../components/line-grid'
import { TransactionDrawer } from '../../../components/transaction-drawer'
import { DocTypeBadge, docTypeMeta } from '../../../components/doc-type-badge'
import { PdfButton } from '../../../components/pdf-button'
import { SendButton } from '../../../components/send-button'
import { confirmDialog } from '../../../lib/confirm'
import { isDocumentRevisionToken } from '@/lib/api/registry-data'
import { promptDialog } from '../../../lib/prompt'
import { FlowManualButtons } from '../../../components/flow-manual-buttons'
import { ApprovalActions } from '../../../components/approval-actions'
import { ApprovalHistory } from '../../../components/approval-history'
import { CONVERSION_TARGETS, type OrderKind } from '../../../lib/order-kinds'
import { HeaderFields } from '../../../components/transaction-form/header-fields'
import type { FormLayoutConfig, HeaderFieldPlacement } from '@openbooks/customization'
import { cmp, fromUnits, mul, sum, toUnits } from '@openbooks/engine/src/money/money.ts'
import { computeLineTaxes, type TaxComponentConfig } from '@openbooks/engine/src/tax/tax.ts'
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
  itemId: string
  accountId: string
  description: string
  quantity: string
  unit: string
  unitPrice: string
  taxProfileId: string
  departmentId: string
  projectId: string
  /** Warehouse for fulfil/receipt effects; blank unless the line's item is
   *  stocked (F-t07-003 pickers). */
  stockLocationId: string
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
  document_date: string | null
  updated_at: string
  subtotal: string
  tax_total: string
  total: string
  party_id: string | null
  party_name: string | null
  document_number: string | null
  extra_dims: Record<string, string>
}

/** Narrow the engine loader's untyped document row to the header fields
 *  this drawer reads. Loader rows always carry strings here, so valid
 *  payloads pass through unchanged; anything else falls back to null (or
 *  '' for the NOT NULL columns). */
export function asOrderDoc(raw: Record<string, unknown>): OrderDoc {
  const text = (value: unknown): string | null =>
    typeof value === 'string' ? value : null
  const dims = (value: unknown): Record<string, string> => {
    if (!isLineMap(value)) return {}
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
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
      // Shipments are immutable evidence on the order they fulfil; the
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
    default:
      return '/'
  }
}

const emptyLine = (segments: SegmentOption[] = []): LineRow => ({
  clientKey: crypto.randomUUID(),
  itemId: '',
  accountId: '',
  description: '',
  quantity: '',
  unit: '',
  unitPrice: '',
  taxProfileId: '',
  departmentId: '',
  projectId: '',
  stockLocationId: '',
  ...Object.fromEntries(segments.map((segment) => [`seg_${segment.key}`, ''])),
})

/** Line text columns are uuids/text-or-null; numerics are handled with String(). */
function lineText(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

function isLineMap(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function toRow(l: Record<string, unknown>, segments: SegmentOption[]): LineRow {
  const extraDims = isLineMap(l.extra_dims) ? l.extra_dims : null
  return {
    // Fresh client identity on every load (see the field comment): the
    // grid's React key must be unique among the live rows.
    clientKey: crypto.randomUUID(),
    itemId: lineText(l.item_id),
    accountId: lineText(l.account_id),
    description: lineText(l.description),
    quantity: l.quantity != null ? String(l.quantity) : '',
    unit: lineText(l.unit),
    unitPrice: l.unit_price != null ? String(l.unit_price) : '',
    taxProfileId: l.tax_group_id ? `group:${l.tax_group_id}` : l.tax_code_id ? `code:${l.tax_code_id}` : '',
    departmentId: lineText(l.department_id),
    projectId: lineText(l.project_id),
    stockLocationId: lineText(l.stock_location_id),
    ...Object.fromEntries(segments.map((segment) => [`seg_${segment.key}`, extraDims?.[segment.key] ?? ''])),
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
}) {
  const { money } = useMoney()
  const t = useTranslations('purchaseOrders.shared')
  const tCommon = useTranslations('common')
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
  const editable = mode === 'edit' && canEditStatus

  const [partyId, setPartyId] = useState<string>(doc.party_id ?? '')
  const [documentDate, setDocumentDate] = useState<string>(doc.document_date ?? '')
  const [dueDate, setDueDate] = useState<string>(doc.due_date ?? '')
  const [memo, setMemo] = useState<string>(doc.memo ?? '')
  const [departmentId, setDepartmentId] = useState<string>(doc.department_id ?? '')
  const [projectId, setProjectId] = useState<string>(doc.project_id ?? '')
  const [subsidiaryId, setSubsidiaryId] = useState<string>(doc.subsidiary_id ?? '')
  const [extraDims, setExtraDims] = useState<Record<string, string>>(doc.extra_dims ?? {})
  const [rows, setRows] = useState<LineRow[]>(
    order.lines.length > 0 ? order.lines.map((line) => toRow(line, segments)) : [emptyLine(segments)],
  )
  const resolvedPriceRef = useRef(new Map<number, { itemId: string; unitPrice: string; basis: PriceBasis }>())
  const priceRequestRef = useRef(new Map<number, number>())
  const [totals, setTotals] = useState({ subtotal: doc.subtotal, taxTotal: doc.tax_total, total: doc.total })
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'dirty' | 'error'>('saved')
  // Saves, statuses, issues, deletes and converts run on the shared action
  // path: a refusal pins here (role=alert) until the next action — a toast
  // alone never survives attention (F-t03-001) — AND toasts, and busy always
  // releases through the package's finally.
  const { busy, refusal, execute, refuse, clearRefusal } = useAppAction()

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

  /** Converted progress across all lines (quantity_billed / quantity). */
  const converted = useMemo(() => {
    let ordered = 0n
    let billed = 0n
    for (const l of order.lines) {
      ordered += toUnits(String(l.quantity ?? 0))
      billed += toUnits(String(l.quantity_billed ?? 0))
    }
    return { ordered: fromUnits(ordered), billed: fromUnits(billed), partial: billed > 0n && billed < ordered, full: ordered > 0n && billed >= ordered }
  }, [order.lines])

  // -- selecting an item defaults description/price/account/tax/unit ----------
  const resolveSellingPrice = (index: number, row: LineRow, allRows: LineRow[]) => {
    if (kind === 'purchase_order' || !row.itemId || !row.quantity) return
    let overallItemQuantity: string
    try {
      overallItemQuantity = sum(allRows.filter((candidate) => candidate.itemId === row.itemId).map((candidate) => candidate.quantity || '0'))
      if (cmp(row.quantity, '0') <= 0 || cmp(overallItemQuantity, '0') <= 0) return
    } catch { return }
    const requestNumber = (priceRequestRef.current.get(index) ?? 0) + 1
    priceRequestRef.current.set(index, requestNumber)
    // The response lands asynchronously: bind it to the row's identity, not
    // its position, so a reorder mid-flight cannot price the wrong line.
    const rowKey = row.clientKey
    void fetch('/api/items/price', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: row.itemId, customerId: partyId || null, currency: doc.currency, onDate: documentDate, lineQuantity: row.quantity, overallItemQuantity }),
    }).then(async (response) => {
      if (!response.ok) return null
      return response.json() as Promise<{ price: {
        unitPrice: string
        source: PriceBasis['kind']
        scheduleId: string | null
        priceLevelId: string | null
        assignmentId: string | null
        resolvedAt: string
      } | null }>
    }).then((payload) => {
      if (!payload?.price || priceRequestRef.current.get(index) !== requestNumber) return
      const price = payload.price
      const basis: PriceBasis = {
        kind: price.source,
        scheduleId: price.scheduleId,
        levelId: price.priceLevelId,
        assignmentId: price.assignmentId,
        unitPrice: price.unitPrice,
        resolvedAt: price.resolvedAt,
      }
      setRows((current) => current.map((candidate, rowIndex) => {
        if (rowIndex !== index || candidate.clientKey !== rowKey || candidate.itemId !== row.itemId || candidate.quantity !== row.quantity) return candidate
        resolvedPriceRef.current.set(index, { itemId: row.itemId, unitPrice: price.unitPrice, basis })
        return { ...candidate, unitPrice: price.unitPrice }
      }))
    }).catch(() => undefined)
  }

  useEffect(() => {
    for (const [index, tracked] of resolvedPriceRef.current) {
      const row = rows[index]
      if (row?.itemId === tracked.itemId) resolveSellingPrice(index, row, rows)
    }
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
            unit: it.unit ?? row.unit,
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
      priceRequestRef.current.clear()
    }
    setRows(merged)
    merged.forEach((row, index) => {
      const prior = priorOf(row, index)
      const itemChanged = Boolean(row.itemId && row.itemId !== prior?.itemId)
      const tracked = resolvedPriceRef.current.get(index)
      const manuallyChanged = Boolean(prior && row.unitPrice !== prior.unitPrice && !itemChanged)
      if (manuallyChanged) resolvedPriceRef.current.delete(index)
      const trackedQuantityChanged = Boolean(tracked && tracked.itemId === row.itemId && prior && row.quantity !== prior.quantity && prior.unitPrice === tracked.unitPrice)
      if (itemChanged || trackedQuantityChanged) resolveSellingPrice(index, row, merged)
    })
  }

  // -- explicit save (no autosave) -------------------------------------------
  const payload = useMemo(
    () => ({
      partyId: partyId || null,
      documentDate: documentDate || undefined,
      dueDate: dueDate || null,
      memo,
      departmentId: departmentId || null,
      projectId: projectId || null,
      ...(subsidiaries.length > 0 ? { subsidiaryId: subsidiaryId || null } : {}),
      extraDims,
      lines: rows
        .filter((r) => {
          try { return Boolean(r.itemId || r.accountId) && cmp(r.quantity, '0') > 0 && cmp(r.unitPrice, '0') >= 0 && cmp(lineAmount(r), '0') > 0 } catch { return false }
        })
        .map((r) => ({
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
          stockLocationId: r.stockLocationId || null,
          extraDims: Object.fromEntries(
            segments
              .filter((segment) => segment.showOnLines)
              .map((segment) => [segment.key, r[`seg_${segment.key}`]])
              .filter(([, value]) => value !== '' && value != null),
          ),
        })),
    }),
    [partyId, documentDate, dueDate, memo, departmentId, projectId, subsidiaryId, subsidiaries.length, extraDims, rows, segments],
  )
  // Track unsaved edits (no autosave — Save is an explicit button). Adjusted
  // during render (same committed value, no extra render).
  const [dirty, setDirty] = useState(false)
  const [prevPayload, setPrevPayload] = useState(payload)
  if (prevPayload !== payload) {
    setPrevPayload(payload)
    if (editable) setDirty(true)
  }

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
    setPartyId(doc.party_id ?? '')
    setDocumentDate(doc.document_date ?? '')
    setDueDate(doc.due_date ?? '')
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
   * (null). Runs at save time (event context), never during render.
   */
  function withPriceBasis<T extends { itemId: string | null; unitPrice: string }>(lines: T[]) {
    return lines.map((line, lineIndex) => ({
      ...line,
      priceBasis: basisForResolvedRow({ row: line, resolved: resolvedPriceRef.current.get(lineIndex) }),
    }))
  }

  async function persistDraft() {
    const saved = await persistOrderDraft({
      request: () => fetch(`${apiBase}/${doc.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, lines: withPriceBasis(payload.lines), expectedUpdatedAt: revisionRef.current }),
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
      setDirty(false)
    }
    return saved
  }

  /** Unsaved-create Save: one idempotent collection POST (status=draft).
   *  The document number allocates inside that transaction — nothing before
   *  this call wrote a row or burned a sequence value. */
  async function persistCreate(): Promise<string | null> {
    const saved = await persistOrderDraft({
      request: () => fetch(apiBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': createKey() },
        body: JSON.stringify({ ...payload, lines: withPriceBasis(payload.lines) }),
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

  // -- line warehouse picker (F-t07-003) ------------------------------------
  // Stocked lines relieve a warehouse at fulfil/receipt/posting, so an order
  // line for stocked goods must name one. The picker appears only when the
  // choice is real (several active locations) and only on stocked rows; a
  // single location is stamped silently by the draft writer instead.
  const stockedItemIds = useMemo(
    () => new Set(items.filter((item) => item.has_inventory_profile === true).map((item) => item.id)),
    [items],
  )
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
        options: items.map((i) => ({ value: i.id, label: `${i.code ? i.code + ' · ' : ''}${i.name ?? ''}`.trim() })),
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
      const placed = !layout ? Object.values(builtIn) : layout.lines.columns.flatMap((placement) => {
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
        ...segments.filter((segment) => segment.showOnLines).map((segment): LineGridColumn<LineRow> => ({
          key: `seg_${segment.key}`,
          label: segment.name,
          width: 'minmax(150px,1.2fr)',
          type: 'search-select',
          options: segment.values.map((value) => ({ value: value.id, label: value.name })),
          placeholder: '—',
        })),
      ]
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accounts, items, taxProfiles, departments, projects, segments, kind, layout, t, tCommon, warehouseColumn],
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
  const canIssue = !!partyId && rows.some((r) => {
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
            <Button disabled={busy} onClick={save}>
              {busy ? tCommon('actions.saving') : tCommon('actions.save')}
            </Button>
          </>
        ) : canManage ? (
          <>
            <PdfButton recordType={kind} recordId={String(doc.id)} />
            <SendButton recordType={kind} recordId={String(doc.id)} />
            <FlowManualButtons subjectKind={kind} subjectId={String(doc.id)} />
            <ApprovalActions subjectKind={kind} subjectId={String(doc.id)} />
            {isDraft ? (
              <Button disabled={busy || !canIssue} onClick={issue} title={!canIssue ? t('issueHint') : undefined}>
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
            {isApproved ? (
              <Button variant="outline" disabled={busy} onClick={voidOrder}>
                {tCommon('actions.void')}
              </Button>
            ) : null}
            {doc.status === 'draft' ? (
              <Button variant="ghost" disabled={busy} onClick={remove} className="text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950/40">
                {tCommon('actions.delete')}
              </Button>
            ) : null}
          </>
        ) : null
      }
      detailTabs={createMode ? [] : [
        {
          key: 'approvals',
          label: tCommon('approvalFlow.historyTitle'),
          content: <ApprovalHistory subjectKind={kind} subjectId={String(doc.id)} showEmptyState />,
        },
      ]}
      footer={
        <div className="flex w-full items-center gap-3">
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
                      onChange={(value) => setExtraDims((current) => ({ ...current, [segment.key]: value ?? '' }))}
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
          <Label>{tCommon('labels.lines')}</Label>
          <LineGrid<LineRow>
            columns={columns}
            rows={rows}
            onRowsChange={onRowsChange}
            emptyRow={() => emptyLine(segments)}
            getRowKey={(row, i) => row.clientKey !== '' ? row.clientKey : `row-${i}`}
            cloneRow={(row) => ({ ...row, clientKey: crypto.randomUUID() })}
            readOnly={!editable}
            formatAmount={(value) => money(value, { currency: doc.currency })}
          />
        </div>

        {order.links.length > 0 ? (
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
        ) : null}
      </div>
    </TransactionDrawer>
  )
}

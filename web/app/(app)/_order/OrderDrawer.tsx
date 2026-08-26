'use client'

import { useMoney } from '@/components/money-provider'
import { initialDrawerMode, type DrawerMode } from '@/lib/drawer-mode'
import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Badge, Button, FieldLabel, Input, Label, SearchSelect } from '@openbooks/ui'
import { LineGrid, type LineGridColumn } from '../../../components/line-grid'
import { TransactionDrawer } from '../../../components/transaction-drawer'
import { DocTypeBadge, docTypeMeta } from '../../../components/doc-type-badge'
import { PdfButton } from '../../../components/pdf-button'
import { SendButton } from '../../../components/send-button'
import { confirmDialog } from '../../../lib/confirm'
import { promptDialog } from '../../../lib/prompt'
import { FlowManualButtons } from '../../../components/flow-manual-buttons'
import { ApprovalActions } from '../../../components/approval-actions'
import { ApprovalHistory } from '../../../components/approval-history'
import { CONVERSION_TARGETS, type OrderKind } from '../../../lib/order-kinds'
import { HeaderFields } from '../../../components/transaction-form/header-fields'
import type { FormLayoutConfig, HeaderFieldPlacement } from '@openbooks/customization'
import { cmp, fromUnits, mul, toUnits } from '@openbooks/engine/src/money.ts'
import { computeLineTaxes, type TaxComponentConfig } from '@openbooks/engine/src/tax.ts'
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
};
interface LineRow extends Record<string, unknown> {
  itemId: string
  accountId: string
  description: string
  quantity: string
  unit: string
  unitPrice: string
  taxProfileId: string
  departmentId: string
  projectId: string
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
  doc: Record<string, any>
  lines: Record<string, unknown>[]
  links: LinkRow[]
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
    default:
      return '/'
  }
}

const emptyLine = (segments: SegmentOption[] = []): LineRow => ({
  itemId: '',
  accountId: '',
  description: '',
  quantity: '',
  unit: '',
  unitPrice: '',
  taxProfileId: '',
  departmentId: '',
  projectId: '',
  ...Object.fromEntries(segments.map((segment) => [`seg_${segment.key}`, ''])),
})

function toRow(l: Record<string, any>, segments: SegmentOption[]): LineRow {
  return {
    itemId: l.item_id ?? '',
    accountId: l.account_id ?? '',
    description: l.description ?? '',
    quantity: l.quantity != null ? String(l.quantity) : '',
    unit: l.unit ?? '',
    unitPrice: l.unit_price != null ? String(l.unit_price) : '',
    taxProfileId: l.tax_group_id ? `group:${l.tax_group_id}` : l.tax_code_id ? `code:${l.tax_code_id}` : '',
    departmentId: l.department_id ?? '',
    projectId: l.project_id ?? '',
    ...Object.fromEntries(segments.map((segment) => [`seg_${segment.key}`, l.extra_dims?.[segment.key] ?? ''])),
  }
}

export function OrderDrawer({
  order,
  initialMode = 'view',
  kind,
  parties,
  accounts,
  items,
  taxCodes,
  taxGroups,
  departments,
  projects,
  subsidiaries,
  segments,
  canManage,
  canOverrideCredit = false,
  layout,
}: {
  order: OrderPayload
  initialMode?: DrawerMode
  kind: OrderKind
  parties: Opt[]
  accounts: Opt[]
  items: Opt[]
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
}) {
  const { money } = useMoney()
  const t = useTranslations('purchaseOrders.shared')
  const tCommon = useTranslations('common')
  const statusLabel = (status: string) => {
    const key = toStatusKey(String(status))
    return STATUS_LABEL_KEYS.has(key) ? tCommon(`status.${key}`) : String(status).replace('_', ' ')
  }
  const router = useRouter()
  const doc = order.doc
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
  const [totals, setTotals] = useState({ subtotal: doc.subtotal, taxTotal: doc.tax_total, total: doc.total })
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'dirty' | 'error'>('saved')
  const [busy, setBusy] = useState(false)

  // Optimistic-concurrency token (documents.updated_at). Every mutating
  // request echoes it; the server refuses any mutation whose view of the
  // order is not the stored revision. A ref — not state — so a save and the
  // issue that immediately follows it share the exact same revision without
  // waiting on a re-render.
  const revisionOf = (value: unknown) => new Date(value as string | number | Date).toISOString()
  const revisionRef = useRef<string>(revisionOf(doc.updated_at))

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
  const onRowsChange = (next: LineRow[]) => {
    const prev = rows
    const merged = next.map((row, i) => {
      if (row.itemId && row.itemId !== prev[i]?.itemId) {
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
    setRows(merged)
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
  // Track unsaved edits (no autosave — Save is an explicit button).
  const [dirty, setDirty] = useState(false)
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    if (editable) setDirty(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload])

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

  async function persistDraft() {
    const saved = await persistOrderDraft({
      request: () => fetch(`${apiBase}/${doc.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, expectedUpdatedAt: revisionRef.current }),
      }),
      setState: setSaveState,
      onError: (message) => toast.error(message ?? t('actionFailed')),
    })
    if (saved) {
      // Adopt the server's post-save revision so the next mutation (e.g. an
      // issue right after this save) fences on what is actually stored.
      if (saved.doc?.updated_at != null) revisionRef.current = revisionOf(saved.doc.updated_at)
      setDirty(false)
    }
    return saved
  }

  async function save() {
    setBusy(true)
    try {
      const saved = await persistDraft()
      if (!saved) return
      setTotals({ subtotal: saved.doc.subtotal, taxTotal: saved.doc.tax_total, total: saved.doc.total })
      setMode('view')
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  function cancel() {
    resetForm()
    setDirty(false)
    setSaveState('saved')
    setMode('view')
  }

  async function setStatus(
    status: 'approved' | 'voided',
    reason?: string,
    creditOverrideReason?: string,
  ) {
    setBusy(true)
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
    const data = await res.json()
    setBusy(false)
    if (!res.ok) {
      if (
        status === 'approved'
        && kind === 'sales_order'
        && canOverrideCredit
        && !creditOverrideReason
        && data.code === 'CUSTOMER_CREDIT_LIMIT_EXCEEDED'
      ) {
        const overrideReason = await promptDialog({
          title: t('creditOverrideTitle'),
          label: t('creditOverrideReasonLabel'),
          placeholder: t('creditOverrideReasonPlaceholder'),
          confirmLabel: t('creditOverrideConfirm'),
        })
        if (overrideReason) await setStatus(status, reason, overrideReason)
        return
      }
      toast.error(data.error ?? t('actionFailed'))
      return
    }
    if (data.doc?.updated_at != null) revisionRef.current = revisionOf(data.doc.updated_at)
    if (data.approvalPending || data.voidPending) {
      toast.success(tCommon('actions.submitForApproval'))
    } else {
      toast.success(status === 'approved' ? t('toastIssued') : t('toastVoided'))
    }
    router.refresh()
  }

  async function issue() {
    // Persist any pending edits first so the server sees the latest lines.
    setBusy(true)
    try {
      await issueSavedOrder({
        persistDraft,
        requestApproval: () => setStatus('approved'),
      })
    } catch {
      toast.error(t('actionFailed'))
    } finally {
      setBusy(false)
    }
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
    setBusy(true)
    const res = await fetch(`${apiBase}/${doc.id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedUpdatedAt: revisionRef.current }),
    })
    if (res.ok) {
      toast.success(t('toastDeleted'))
      router.push(meta.base)
      router.refresh()
    } else {
      toast.error((await res.json()).error ?? t('actionFailed'))
      setBusy(false)
    }
  }

  async function convert(
    targetKind: string,
    label: string,
    creditOverrideReason?: string,
  ) {
    setBusy(true)
    const res = await fetch(`${apiBase}/${doc.id}/convert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetKind,
        creditOverrideReason,
        expectedUpdatedAt: revisionRef.current,
      }),
    })
    const data = await res.json()
    setBusy(false)
    if (!res.ok) {
      if (
        targetKind === 'sales_order'
        && canOverrideCredit
        && !creditOverrideReason
        && data.code === 'CUSTOMER_CREDIT_LIMIT_EXCEEDED'
      ) {
        const overrideReason = await promptDialog({
          title: t('creditOverrideTitle'),
          label: t('creditOverrideReasonLabel'),
          placeholder: t('creditOverrideReasonPlaceholder'),
          confirmLabel: t('creditOverrideConfirm'),
        })
        if (overrideReason) await convert(targetKind, label, overrideReason)
        return
      }
      toast.error(data.error ?? t('convertFailed'))
      return
    }
    toast.success(t('convertCreated', { target: label, number: data.documentNumber }))
    router.push(targetHref(data.kind, data.id))
    router.refresh()
  }

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
    [accounts, items, taxProfiles, departments, projects, segments, kind, layout, t, tCommon],
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
      closeHref={meta.base}
      recordId={String(doc.id)}
      canEditAttachments={canManage}
      panelClassName={docTypeMeta(kind).surfaceCls}
      title={
        <span className="flex items-center gap-2.5">
          <DocTypeBadge kind={kind} />
          <span className="font-mono">{doc.document_number}</span>
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
          <Button variant="outline" size="sm" className="h-8 px-2.5 text-xs" disabled={busy} onClick={() => mode === 'edit' ? cancel() : setMode('edit')}>
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
                    disabled={busy}
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
      detailTabs={[
        {
          key: 'approvals',
          label: tCommon('approvalFlow.historyTitle'),
          content: <ApprovalHistory subjectKind={kind} subjectId={String(doc.id)} />,
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

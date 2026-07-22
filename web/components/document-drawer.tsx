'use client'

import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Badge, Button, Input, Label, SearchSelect, Select } from '@openbooks/ui'
import { TransactionDrawer } from './transaction-drawer'
import { LineGrid, type LineGridColumn } from './line-grid'
import { CustomFieldInputs, customFieldColumns, type CustomFieldDefClient } from './custom-field-inputs'
import { CustomFieldInput } from './custom-field-input'
import { HeaderFields } from './transaction-form/header-fields'
import { DocTypeBadge, docTypeMeta } from './doc-type-badge'
import { PdfButton } from './pdf-button'
import { FlowManualButtons } from './flow-manual-buttons'
import { ApprovalActions } from './approval-actions'
import { ApprovalHistory } from './approval-history'
import { PDF_RECORD_TYPE_BY_KEY } from '../lib/pdf-templates/catalog'
import { money } from '../lib/format'
import { cmp } from '@openbooks/engine/src/money.ts'
import { computeLineTaxes, type TaxComponentConfig } from '@openbooks/engine/src/tax.ts'
import { confirmDialog } from '../lib/confirm'
import { runClientScripts } from '../lib/client-scripts'
import type { DocKindConfig } from '../lib/document-kinds'
import {
  type FormLayoutConfig,
  type HeaderFieldPlacement,
  type LineColumnPlacement,
  customFieldDefKey,
  isCustomFieldKey,
  lineFieldMeta,
  FORM_ACTION_KEYS,
} from '@openbooks/customization'

interface Opt {
  id: string
  display_name?: string
  number?: string
  name?: string
  code?: string
  rate?: string
  label?: string
  subsidiary_id?: string | null
  tax_components?: TaxComponentConfig[]
}

interface SubsidiaryOpt {
  id: string
  name: string
  /** Root = 0; used to indent the picker like a tree. */
  depth: number
}
interface SegmentOpt {
  key: string
  name: string
  showOnHeader: boolean
  showOnLines: boolean
  values: { id: string; code: string | null; name: string }[]
}
interface BuiltinSegmentOpt {
  key: string
  storageColumn: string | null
  showOnHeader: boolean
  showOnLines: boolean
}
interface LineRow extends Record<string, unknown> {
  accountId: string
  itemId: string
  description: string
  quantity: string
  unit: string
  unitPrice: string
  departmentId: string
  projectId: string
  locationId: string
  classId: string
  taxProfileId: string
  amount: string
  taxOverridden: boolean
  taxAmount: string
}
interface DocPayload {
  doc: Record<string, any>
  lines: Record<string, any>[]
}

const STATUS_VARIANT: Record<string, 'default' | 'success' | 'secondary' | 'warning' | 'outline'> = {
  open: 'default',
  paid: 'success',
  posted: 'success',
  approved: 'success',
  pending_approval: 'warning',
  draft: 'secondary',
  voided: 'outline',
}

const STATUS_KEYS: Record<string, string> = {
  draft: 'draft',
  pending_approval: 'pendingApproval',
  approved: 'approved',
  posted: 'posted',
  open: 'open',
  paid: 'paid',
  voided: 'voided',
}

const emptyLine = (): LineRow => ({
  accountId: '',
  itemId: '',
  description: '',
  quantity: '',
  unit: '',
  unitPrice: '',
  departmentId: '',
  projectId: '',
  locationId: '',
  classId: '',
  taxProfileId: '',
  amount: '',
  taxOverridden: false,
  taxAmount: '',
})

function positiveAmount(value: unknown): boolean {
  try { return cmp(String(value ?? ''), '0') > 0 } catch { return false }
}

function toRow(l: Record<string, any>, lineDefs: CustomFieldDefClient[], segments: SegmentOpt[]): LineRow {
  const row: LineRow = {
    accountId: l.account_id ?? '',
    itemId: l.item_id ?? '',
    description: l.description ?? '',
    quantity: l.quantity != null ? String(l.quantity) : '',
    unit: l.unit ?? '',
    unitPrice: l.unit_price != null ? String(l.unit_price) : '',
    departmentId: l.department_id ?? '',
    projectId: l.project_id ?? '',
    locationId: l.location_id ?? '',
    classId: l.class_id ?? '',
    taxProfileId: l.tax_group_id ? `group:${l.tax_group_id}` : l.tax_code_id ? `code:${l.tax_code_id}` : '',
    amount: l.amount != null ? String(l.amount) : '',
    taxOverridden: l.tax_overridden === true,
    taxAmount: l.tax_amount != null ? String(l.tax_amount) : '',
  }
  for (const def of lineDefs) row[`cf_${def.key}`] = (l.custom ?? {})[def.key] ?? ''
  for (const segment of segments) row[`seg_${segment.key}`] = (l.extra_dims ?? {})[segment.key] ?? ''
  return row
}

export interface DocumentDrawerProps {
  payload: DocPayload
  config: DocKindConfig
  basePath: string
  parties?: Opt[]
  accounts: Opt[]
  taxCodes?: Opt[]
  taxGroups?: Opt[]
  cards?: Opt[]
  bankAccounts?: Opt[]
  departments: Opt[]
  projects: Opt[]
  locations?: Opt[]
  classes?: Opt[]
  segments?: SegmentOpt[]
  builtinSegments?: BuiltinSegmentOpt[]
  items?: Opt[]
  /** The org's subsidiaries (depth-first tree order). Only passed by pages in
   *  multi-subsidiary orgs — empty/undefined renders NO subsidiary UI. */
  subsidiaries?: SubsidiaryOpt[]
  headerDefs: CustomFieldDefClient[]
  lineDefs: CustomFieldDefClient[]
  canCreate: boolean
  canPost: boolean
  /** Resolved transaction form layout; when present the header + line columns
   *  render from it (move/hide/rename/custom fields). Omitted only for the
   *  defensive legacy-free fallback used while a page is loading. */
  layout?: FormLayoutConfig
  /** Available org form layouts (for the per-record "Custom Form" picker). */
  availableLayouts?: { id: string; name: string }[]
  currentLayoutId?: string | null
  /** Record-type key (for the form-preference API). */
  recordType?: string
  /** User holds admin.customization.manage — shows the Customize entry that
   *  deep-links into the form designer for this record type. */
  canCustomize?: boolean
}

export function DocumentDrawer({
  payload,
  config,
  basePath,
  parties,
  accounts,
  taxCodes,
  taxGroups,
  cards,
  bankAccounts,
  departments,
  projects,
  locations,
  classes,
  segments = [],
  builtinSegments = [],
  items,
  subsidiaries,
  headerDefs,
  lineDefs,
  canCreate,
  canPost,
  layout,
  availableLayouts,
  currentLayoutId,
  recordType,
  canCustomize,
}: DocumentDrawerProps) {
  const t = useTranslations(config.i18n)
  const tCommon = useTranslations('common')
  const router = useRouter()
  const doc = payload.doc
  const isDraft = doc.status === 'draft'
  const isPosted = doc.status === 'posted'
  const isTransfer = config.kind === 'transfer'

  const canEditStatus =
    (doc.status === 'draft' || doc.status === 'approved' || doc.status === 'posted') && canCreate
  // Record flyouts ALWAYS open read-only (source platform view-mode model); editing
  // is an explicit Edit → Save/Cancel cycle from the header.
  const [mode, setMode] = useState<'view' | 'edit'>('view')
  const editable = mode === 'edit' && canEditStatus
  // Posted open-item docs that carry a balance resolve to open/paid from the
  // applications ledger (invoices). Credits post open items too but their
  // "applied" flows the opposite direction, so they show their raw status.
  const displayStatus = isPosted && config.showsBalance
    ? cmp(String(doc.balance_due ?? '0'), '0') > 0
      ? 'open'
      : 'paid'
    : doc.status

  const [partyId, setPartyId] = useState<string>(doc.party_id ?? '')
  const [paymentCardId, setPaymentCardId] = useState<string>(doc.payment_card_id ?? '')
  const [documentDate, setDocumentDate] = useState<string>(doc.document_date ?? '')
  const [dueDate, setDueDate] = useState<string>(doc.due_date ?? '')
  const [referenceNumber, setReferenceNumber] = useState<string>(doc.reference_number ?? '')
  const [memo, setMemo] = useState<string>(doc.memo ?? '')
  // Full-schema header built-ins (off by default; shown when a form enables them).
  const [postingDate, setPostingDate] = useState<string>(doc.posting_date ?? '')
  const [departmentId, setDepartmentId] = useState<string>(doc.department_id ?? '')
  const [projectIdHeader, setProjectIdHeader] = useState<string>(doc.project_id ?? '')
  const [locationId, setLocationId] = useState<string>(doc.location_id ?? '')
  const [classId, setClassId] = useState<string>(doc.class_id ?? '')
  const [subsidiaryId, setSubsidiaryId] = useState<string>(doc.subsidiary_id ?? '')
  const [expectedPayDate, setExpectedPayDate] = useState<string>(doc.expected_pay_date ?? '')
  const [paymentHoldReason, setPaymentHoldReason] = useState<string>(doc.payment_hold_reason ?? '')
  const [internalNotes, setInternalNotes] = useState<string>(doc.internal_notes ?? '')
  const [billingMethod, setBillingMethod] = useState<string>(doc.billing_method ?? '')
  const [isFinalInvoice, setIsFinalInvoice] = useState<boolean>(doc.is_final_invoice === true)
  const [customValues, setCustomValues] = useState<Record<string, unknown>>(doc.custom ?? {})
  const [extraDims, setExtraDims] = useState<Record<string, string>>(doc.extra_dims ?? {})

  // -- transfer: dedicated to/from + amount state ---------------------------
  const initialTransfer = isTransfer
    ? {
        toAccount: payload.lines[0]?.account_id ?? '',
        fromAccount: payload.lines[1]?.account_id ?? '',
        amount: payload.lines[0]?.amount != null ? String(payload.lines[0].amount) : '',
      }
    : null
  const [transfer, setTransfer] = useState(initialTransfer)

  const [rows, setRows] = useState<LineRow[]>(
    payload.lines.length > 0 ? payload.lines.map((l) => toRow(l, lineDefs, segments)) : [emptyLine()],
  )
  const [totals, setTotals] = useState({ subtotal: doc.subtotal, taxTotal: doc.tax_total, total: doc.total })
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'dirty' | 'error'>('saved')
  const [busy, setBusy] = useState(false)

  const taxProfiles = useMemo(() => [
    ...(taxCodes ?? []).map((profile) => ({ ...profile, value: `code:${profile.id}` })),
    ...(taxGroups ?? []).map((profile) => ({ ...profile, value: `group:${profile.id}` })),
  ], [taxCodes, taxGroups])
  const taxByProfile = useMemo(
    () => new Map(taxProfiles.map((profile) => [profile.value, profile.tax_components ?? []])),
    [taxProfiles],
  )
  const lineTax = (row: LineRow) => {
    try {
      return computeLineTaxes(String(row.amount || '0'), taxByProfile.get(row.taxProfileId) ?? []).taxTotal
    } catch {
      return '0.0000'
    }
  }

  // -- subsidiaries (multi-subsidiary orgs only; empty/undefined = no UI) ----
  const multiSub = (subsidiaries?.length ?? 0) > 0
  const subsidiaryOpts = useMemo(
    () => (subsidiaries ?? []).map((s) => ({ value: s.id, label: '\u2003'.repeat(s.depth) + s.name })),
    [subsidiaries],
  )
  const subsidiaryName = (id: unknown): string =>
    (subsidiaries ?? []).find((s) => s.id === id)?.name ?? '—'
  /** Picking a party on a draft defaults the document's subsidiary to the party's primary. */
  const changeParty = (v: string | null | undefined) => {
    setPartyId(v ?? '')
    if (multiSub && isDraft && v) {
      const sub = (parties ?? []).find((p) => p.id === v)?.subsidiary_id
      if (sub) setSubsidiaryId(sub)
    }
  }

  const payload_ = useMemo(() => {
    if (isTransfer) {
      return {
        paymentCardId: null,
        partyId: null,
        documentDate: documentDate || undefined,
        dueDate: null,
        referenceNumber: null,
        memo,
        // Only sent in multi-subsidiary orgs (undefined drops out of the JSON body).
        subsidiaryId: multiSub ? subsidiaryId || null : undefined,
        extraDims,
        custom: customValues,
        lines: transfer
          ? [
              { accountId: transfer.toAccount, amount: transfer.amount, description: null },
              { accountId: transfer.fromAccount, amount: transfer.amount, description: null },
            ].filter((l) => l.accountId && positiveAmount(l.amount))
          : [],
      }
    }
    return {
      partyId: partyId || null,
      paymentCardId: config.fundingSource === 'card' ? paymentCardId || null : null,
      documentDate: documentDate || undefined,
      dueDate: config.hasDueDate ? dueDate || null : null,
      referenceNumber: config.hasReference ? referenceNumber : null,
      memo,
      // Full-schema header built-ins (persisted only when the form exposes them,
      // but harmless to always send — the API updates the columns directly).
      postingDate: postingDate || null,
      departmentId: departmentId || null,
      projectId: projectIdHeader || null,
      locationId: locationId || null,
      classId: classId || null,
      extraDims,
      // Only sent in multi-subsidiary orgs (undefined drops out of the JSON body).
      subsidiaryId: multiSub ? subsidiaryId || null : undefined,
      expectedPayDate: expectedPayDate || null,
      paymentHoldReason: paymentHoldReason || null,
      internalNotes: internalNotes || null,
      billingMethod: billingMethod || null,
      isFinalInvoice,
      custom: customValues,
      lines: rows
        .filter((r) => r.accountId && positiveAmount(r.amount))
        .map((r) => ({
          accountId: r.accountId,
          itemId: r.itemId || null,
          description: r.description,
          quantity: r.quantity !== '' ? r.quantity : null,
          unit: r.unit || null,
          unitPrice: r.unitPrice !== '' ? r.unitPrice : null,
          amount: r.amount,
          taxCodeId: config.hasTax && r.taxProfileId.startsWith('code:') ? r.taxProfileId.slice(5) : null,
          taxGroupId: config.hasTax && r.taxProfileId.startsWith('group:') ? r.taxProfileId.slice(6) : null,
          taxOverridden: config.hasTax ? r.taxOverridden : false,
          taxAmount: config.hasTax && r.taxOverridden ? r.taxAmount : null,
          departmentId: r.departmentId || null,
          projectId: r.projectId || null,
          locationId: r.locationId || null,
          classId: r.classId || null,
          extraDims: Object.fromEntries(
            segments
              .map((segment) => [segment.key, r[`seg_${segment.key}`]])
              .filter(([, value]) => value !== '' && value != null),
          ),
          custom: Object.fromEntries(
            lineDefs.map((d) => [d.key, r[`cf_${d.key}`]]).filter(([, v]) => v !== '' && v != null),
          ),
        })),
    }
  }, [isTransfer, transfer, partyId, paymentCardId, documentDate, dueDate, referenceNumber, memo, postingDate, departmentId, projectIdHeader, locationId, classId, subsidiaryId, multiSub, expectedPayDate, paymentHoldReason, internalNotes, billingMethod, isFinalInvoice, customValues, extraDims, rows, lineDefs, segments, config])

  const [dirty, setDirty] = useState(false)
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    if (editable) setDirty(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload_])

  function resetForm() {
    setPartyId(doc.party_id ?? '')
    setPaymentCardId(doc.payment_card_id ?? '')
    setDocumentDate(doc.document_date ?? '')
    setDueDate(doc.due_date ?? '')
    setReferenceNumber(doc.reference_number ?? '')
    setMemo(doc.memo ?? '')
    setPostingDate(doc.posting_date ?? '')
    setDepartmentId(doc.department_id ?? '')
    setProjectIdHeader(doc.project_id ?? '')
    setLocationId(doc.location_id ?? '')
    setClassId(doc.class_id ?? '')
    setSubsidiaryId(doc.subsidiary_id ?? '')
    setExpectedPayDate(doc.expected_pay_date ?? '')
    setPaymentHoldReason(doc.payment_hold_reason ?? '')
    setInternalNotes(doc.internal_notes ?? '')
    setBillingMethod(doc.billing_method ?? '')
    setIsFinalInvoice(doc.is_final_invoice === true)
    setCustomValues(doc.custom ?? {})
    setExtraDims(doc.extra_dims ?? {})
    setTransfer(initialTransfer)
    setRows(payload.lines.length > 0 ? payload.lines.map((l) => toRow(l, lineDefs, segments)) : [emptyLine()])
    setTotals({ subtotal: doc.subtotal, taxTotal: doc.tax_total, total: doc.total })
  }

  async function save() {
    setBusy(true)
    setSaveState('saving')
    // Client scripts (sandboxed, opaque-origin evaluator) gate the save: an
    // explicit { abort } blocks; { warnings } toast and proceed; fail-open.
    const gate = await runClientScripts(config.kind, payload_)
    if (!gate.ok) {
      toast.error(gate.reason ?? t('toasts.actionFailed'))
      setSaveState('error')
      setBusy(false)
      return
    }
    for (const w of gate.warnings) toast.warning(w)
    const res = await fetch(`/api/documents/${doc.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload_),
    })
    if (res.ok) {
      const data = (await res.json()) as DocPayload
      setTotals({ subtotal: data.doc.subtotal, taxTotal: data.doc.tax_total, total: data.doc.total })
      setSaveState('saved')
      setDirty(false)
      setMode('view')
      router.refresh()
    } else {
      setSaveState('error')
      toast.error((await res.json()).error ?? t('toasts.actionFailed'))
    }
    setBusy(false)
  }

  function cancel() {
    resetForm()
    setDirty(false)
    setSaveState('saved')
    setMode('view')
  }

  async function act(action: 'submit' | 'post') {
    setBusy(true)
    const res = await fetch('/api/documents/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, documentId: doc.id }),
    })
    const data = await res.json()
    if (!res.ok) toast.error(data.error ?? t('toasts.actionFailed'))
    else toast.success(action === 'submit' ? t('toasts.submitted') : t('toasts.posted'))
    setBusy(false)
    router.refresh()
  }

  async function remove() {
    if (
      !(await confirmDialog({
        title: t('drawer.deleteTitle'),
        message: isPosted ? t('drawer.deletePostedBody') : t('drawer.deleteDraftBody'),
        confirmLabel: tCommon('actions.delete'),
        tone: 'danger',
      }))
    )
      return
    setBusy(true)
    const res = await fetch(`/api/documents/${doc.id}`, { method: 'DELETE' })
    if (res.ok) {
      toast.success(t('toasts.deleted'))
      router.push(basePath)
      router.refresh()
    } else {
      toast.error((await res.json()).error ?? t('toasts.deleteFailed'))
      setBusy(false)
    }
  }

  // -- grid columns (line-based kinds; transfer uses its own fields) --------
  const columns = useMemo<LineGridColumn<LineRow>[]>(() => {
    const cols: LineGridColumn<LineRow>[] = [
      {
        key: 'accountId',
        label: t('drawer.accountColumn'),
        width: 'minmax(200px,2fr)',
        type: 'search-select',
        required: true,
        options: accounts.map((a) => ({ value: a.id, label: `${a.number ?? ''} ${a.name ?? ''}`.trim() })),
        placeholder: t('drawer.accountPlaceholder'),
      },
      { key: 'description', label: tCommon('labels.description'), width: 'minmax(160px,1.6fr)', type: 'text' },
      {
        key: 'departmentId',
        label: tCommon('labels.department'),
        width: '140px',
        type: 'select',
        options: [{ value: '', label: '—' }, ...departments.map((d) => ({ value: d.id, label: d.name ?? '' }))],
      },
      {
        key: 'projectId',
        label: tCommon('labels.project'),
        width: 'minmax(150px,1.2fr)',
        type: 'search-select',
        options: projects.map((p) => ({ value: p.id, label: p.name ?? '' })),
        placeholder: '—',
      },
    ]
    if (config.hasTax) {
      cols.push({
        key: 'taxProfileId',
        label: tCommon('labels.tax'),
        width: '110px',
        type: 'select',
        options: [{ value: '', label: t('drawer.noTax') }, ...taxProfiles.map((profile) => ({ value: profile.value, label: profile.code ?? '' }))],
      })
    }
    for (const segment of segments.filter((item) => item.showOnLines)) {
      cols.push({
        key: `seg_${segment.key}`,
        label: segment.name,
        width: '150px',
        type: 'search-select',
        options: segment.values.map((value) => ({
          value: value.id,
          label: `${value.code ? `${value.code} · ` : ''}${value.name}`,
        })),
        placeholder: '—',
      })
    }
    for (const c of customFieldColumns<LineRow>(lineDefs)) cols.push(c)
    cols.push({ key: 'amount', label: tCommon('labels.amount'), width: '120px', type: 'amount', align: 'right', required: true })
    if (config.hasTax) {
      cols.push({
        key: 'taxAmount',
        label: t('drawer.taxAmountColumn'),
        width: '120px',
        type: 'tax',
        align: 'right',
        computeTax: lineTax,
        onTaxChange: (index, next) =>
          setRows((prev) =>
            prev.map((r, j) =>
              j === index ? { ...r, taxOverridden: next.overridden, taxAmount: next.taxAmount } : r,
            ),
          ),
      })
    }
    const lineVisibility = new Map(builtinSegments.map((segment) => [segment.storageColumn, segment.showOnLines]))
    const storageForRowKey: Record<string, string> = {
      departmentId: 'department_id', projectId: 'project_id', locationId: 'location_id', classId: 'class_id',
    }
    return cols.filter((column) => {
      const storage = storageForRowKey[String(column.key)]
      return !storage || lineVisibility.get(storage) !== false
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts, departments, projects, taxProfiles, lineDefs, segments, builtinSegments, config, t, tCommon])

  const field = 'space-y-1.5'
  const accountName = (id: unknown): string => {
    if (!id) return '—'
    const a = (bankAccounts ?? accounts).find((x) => x.id === id) ?? accounts.find((x) => x.id === id)
    return a ? `${a.number ?? ''} ${a.name ?? ''}`.trim() : String(id)
  }
  const partyLabel = config.partyRole === 'customer' ? tCommon('labels.customer') : tCommon('labels.vendor')
  const partyPlaceholder = config.partyRole === 'customer' ? t('drawer.selectCustomerPlaceholder') : t('drawer.selectVendorPlaceholder')

  // -- layout-driven path: header via <HeaderFields> + line columns from the
  //    resolved FormLayoutConfig. The hardcoded path is a defensive fallback
  //    for callers that have not resolved a tenant form yet. -----------------
  const useLayout = !!layout

  // A multi-subsidiary org's transaction must ALWAYS show its subsidiary, even
  // if a user-customized layout hides the field — mirror how required built-ins
  // render by force-showing it after the layout groups.
  const layoutShowsSubsidiary =
    !!layout && layout.header.groups.some((g) => g.fields.some((f) => f.key === 'subsidiary_id' && f.visible))

  const cfColumns = useMemo(() => {
    const m = new Map<string, LineGridColumn<LineRow>>()
    for (const c of customFieldColumns<LineRow>(lineDefs)) m.set(c.key, c)
    return m
  }, [lineDefs])

  const columnsFromLayout = useMemo<LineGridColumn<LineRow>[]>(() => {
    if (!layout) return columns
    const builtIn: Record<string, Omit<LineGridColumn<LineRow>, 'label'>> = {
      account_id: {
        key: 'accountId', width: 'minmax(200px,2fr)', type: 'search-select', required: true,
        options: accounts.map((a) => ({ value: a.id, label: `${a.number ?? ''} ${a.name ?? ''}`.trim() })),
        placeholder: t('drawer.accountPlaceholder'),
      },
      item_id: {
        key: 'itemId', width: 'minmax(150px,1.4fr)', type: 'search-select',
        options: (items ?? []).map((it) => ({ value: it.id, label: `${it.code ? it.code + ' ' : ''}${it.name ?? ''}`.trim() })), placeholder: '—',
      },
      description: { key: 'description', width: 'minmax(160px,1.6fr)', type: 'text' },
      quantity: { key: 'quantity', width: '90px', type: 'text', align: 'right' },
      unit: { key: 'unit', width: '80px', type: 'text' },
      unit_price: { key: 'unitPrice', width: '110px', type: 'amount', align: 'right' },
      department_id: {
        key: 'departmentId', width: '140px', type: 'select',
        options: [{ value: '', label: '—' }, ...departments.map((d) => ({ value: d.id, label: d.name ?? '' }))],
      },
      project_id: {
        key: 'projectId', width: 'minmax(150px,1.2fr)', type: 'search-select',
        options: projects.map((p) => ({ value: p.id, label: p.name ?? '' })), placeholder: '—',
      },
      location_id: {
        key: 'locationId', width: '140px', type: 'select',
        options: [{ value: '', label: '—' }, ...(locations ?? []).map((l) => ({ value: l.id, label: l.name ?? '' }))],
      },
      class_id: {
        key: 'classId', width: '140px', type: 'select',
        options: [{ value: '', label: '—' }, ...(classes ?? []).map((c) => ({ value: c.id, label: c.name ?? '' }))],
      },
      tax_code_id: {
        key: 'taxProfileId', width: '110px', type: 'select',
        options: [{ value: '', label: t('drawer.noTax') }, ...taxProfiles.map((profile) => ({ value: profile.value, label: profile.code ?? '' }))],
      },
      amount: { key: 'amount', width: '120px', type: 'amount', align: 'right', required: true },
      tax_amount: {
        key: 'taxAmount', width: '120px', type: 'tax', align: 'right', computeTax: lineTax,
        onTaxChange: (index, next) =>
          setRows((prev) => prev.map((r, j) => (j === index ? { ...r, taxOverridden: next.overridden, taxAmount: next.taxAmount } : r))),
      },
    }
    const defLabel: Record<string, string> = {
      account_id: t('drawer.accountColumn'),
      item_id: tCommon('labels.item'),
      description: tCommon('labels.description'),
      quantity: tCommon('labels.quantity'),
      unit: tCommon('labels.unit'),
      unit_price: tCommon('labels.unitPrice'),
      department_id: tCommon('labels.department'),
      project_id: tCommon('labels.project'),
      location_id: tCommon('labels.location'),
      class_id: tCommon('labels.class'),
      tax_code_id: tCommon('labels.tax'),
      amount: tCommon('labels.amount'),
      tax_amount: t('drawer.taxAmountColumn'),
    }
    const configured = layout.lines.columns
      .filter((p: LineColumnPlacement) => p.visible && builtinSegments.find((segment) => segment.storageColumn === p.key)?.showOnLines !== false)
      .map((p): LineGridColumn<LineRow> | null => {
        if (isCustomFieldKey(p.key)) {
          const base = cfColumns.get(p.key)
          if (!base) return null
          return { ...base, width: p.width ?? base.width, label: p.labelOverride?.trim() ? p.labelOverride.trim() : base.label }
        }
        const base = builtIn[p.key]
        if (!base) return null
        const meta = recordType ? lineFieldMeta(recordType, p.key) : undefined
        return {
          ...base,
          width: p.width ?? base.width,
          required: meta?.required ?? (base as { required?: boolean }).required,
          label: p.labelOverride?.trim() ? p.labelOverride.trim() : (defLabel[p.key] ?? p.key),
        }
      })
      .filter((c): c is LineGridColumn<LineRow> => c !== null)
    return [...configured, ...columns.filter((column) => String(column.key).startsWith('seg_'))]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, accounts, departments, projects, locations, classes, items, taxProfiles, lineDefs, cfColumns, columns, recordType, builtinSegments, t, tCommon])

  const headerDefByDefKey = useMemo(() => new Map(headerDefs.map((d) => [d.key, d])), [headerDefs])
  const defLabelForHeader = (key: string): string => {
    switch (key) {
      case 'party_id': return partyLabel
      case 'payment_card_id': return t('drawer.card')
      case 'document_date': return t('drawer.dateLabel')
      case 'due_date': return t('drawer.dueDate')
      case 'reference_number': return t('drawer.reference')
      case 'memo': return tCommon('labels.memo')
      case 'posting_date': return tCommon('labels.postingDate')
      case 'department_id': return tCommon('labels.department')
      case 'project_id': return tCommon('labels.project')
      case 'location_id': return tCommon('labels.location')
      case 'class_id': return tCommon('labels.class')
      case 'subsidiary_id': return tCommon('labels.subsidiary')
      case 'expected_pay_date': return tCommon('labels.expectedPayDate')
      case 'payment_hold_reason': return tCommon('labels.paymentHold')
      case 'internal_notes': return tCommon('labels.internalNotes')
      case 'billing_method': return tCommon('labels.billingMethod')
      case 'is_final_invoice': return tCommon('labels.finalInvoice')
      default:
        if (isCustomFieldKey(key)) return headerDefByDefKey.get(customFieldDefKey(key))?.label ?? key
        return key
    }
  }

  // Look up a dimension/entity display name for read-only header rendering.
  const optName = (opts: Opt[] | undefined, id: unknown): string =>
    (opts ?? []).find((o) => o.id === id)?.name ?? (opts ?? []).find((o) => o.id === id)?.display_name ?? '—'

  const renderHeaderField = (p: HeaderFieldPlacement, isEditable: boolean): React.ReactNode => {
    if (builtinSegments.find((segment) => segment.storageColumn === p.key)?.showOnHeader === false) return null
    const label = p.labelOverride?.trim() ? p.labelOverride.trim() : defLabelForHeader(p.key)
    const required = p.required === true
    switch (p.key) {
      case 'party_id':
        return (
          <>
            <Label>{label}{required && isEditable ? <span className="text-red-500"> *</span> : null}</Label>
            {isEditable ? (
              <SearchSelect
                options={(parties ?? []).map((v) => ({ value: v.id, label: v.display_name ?? '' }))}
                value={partyId}
                onChange={changeParty}
                placeholder={partyPlaceholder}
              />
            ) : (<p className="text-sm">{doc.party_name}</p>)}
          </>
        )
      case 'payment_card_id':
        return (
          <>
            <Label>{label}{required && isEditable ? <span className="text-red-500"> *</span> : null}</Label>
            {isEditable ? (
              <SearchSelect
                options={(cards ?? []).map((c) => ({ value: c.id, label: c.display_name ?? c.label ?? '' }))}
                value={paymentCardId}
                onChange={(v) => setPaymentCardId(v ?? '')}
                placeholder={t('drawer.selectCardPlaceholder')}
              />
            ) : (
              <p className="text-sm">
                {(cards ?? []).find((c) => c.id === doc.payment_card_id)?.display_name ?? doc.payment_card_id ?? '—'}
              </p>
            )}
          </>
        )
      case 'document_date':
        return (
          <>
            <Label>{label}</Label>
            {isEditable ? (
              <Input type="date" value={documentDate} onChange={(e) => setDocumentDate(e.target.value)} />
            ) : (<p className="text-sm">{doc.document_date}</p>)}
          </>
        )
      case 'due_date':
        return (
          <>
            <Label>{label}</Label>
            {isEditable ? (
              <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            ) : (<p className="text-sm">{doc.due_date ?? '—'}</p>)}
          </>
        )
      case 'reference_number':
        return (
          <>
            <Label>{label}</Label>
            {isEditable ? (
              <Input value={referenceNumber} onChange={(e) => setReferenceNumber(e.target.value)} />
            ) : (<p className="text-sm">{doc.reference_number ?? '—'}</p>)}
          </>
        )
      case 'memo':
        return (
          <>
            <Label>{label}</Label>
            {isEditable ? (
              <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
            ) : (<p className="text-sm">{doc.memo ?? '—'}</p>)}
          </>
        )
      case 'posting_date':
        return (
          <>
            <Label>{label}</Label>
            {isEditable ? (
              <Input type="date" value={postingDate} onChange={(e) => setPostingDate(e.target.value)} />
            ) : (<p className="text-sm">{doc.posting_date ?? '—'}</p>)}
          </>
        )
      case 'expected_pay_date':
        return (
          <>
            <Label>{label}</Label>
            {isEditable ? (
              <Input type="date" value={expectedPayDate} onChange={(e) => setExpectedPayDate(e.target.value)} />
            ) : (<p className="text-sm">{doc.expected_pay_date ?? '—'}</p>)}
          </>
        )
      case 'department_id':
        return (
          <>
            <Label>{label}</Label>
            {isEditable ? (
              <SearchSelect options={(departments ?? []).map((d) => ({ value: d.id, label: d.name ?? '' }))} value={departmentId} onChange={(v) => setDepartmentId(v ?? '')} placeholder="—" />
            ) : (<p className="text-sm">{optName(departments, doc.department_id)}</p>)}
          </>
        )
      case 'project_id':
        return (
          <>
            <Label>{label}</Label>
            {isEditable ? (
              <SearchSelect options={(projects ?? []).map((pr) => ({ value: pr.id, label: pr.name ?? '' }))} value={projectIdHeader} onChange={(v) => setProjectIdHeader(v ?? '')} placeholder="—" />
            ) : (<p className="text-sm">{optName(projects, doc.project_id)}</p>)}
          </>
        )
      case 'location_id':
        return (
          <>
            <Label>{label}</Label>
            {isEditable ? (
              <SearchSelect options={(locations ?? []).map((l) => ({ value: l.id, label: l.name ?? '' }))} value={locationId} onChange={(v) => setLocationId(v ?? '')} placeholder="—" />
            ) : (<p className="text-sm">{optName(locations, doc.location_id)}</p>)}
          </>
        )
      case 'class_id':
        return (
          <>
            <Label>{label}</Label>
            {isEditable ? (
              <SearchSelect options={(classes ?? []).map((c) => ({ value: c.id, label: c.name ?? '' }))} value={classId} onChange={(v) => setClassId(v ?? '')} placeholder="—" />
            ) : (<p className="text-sm">{optName(classes, doc.class_id)}</p>)}
          </>
        )
      case 'subsidiary_id': {
        // HARD RULE: no subsidiary UI in single-subsidiary orgs, even if a
        // form layout carries the field. Locked (read-only) once posted — the
        // subsidiary shapes the GL and intercompany balancing.
        if (!multiSub) return null
        const rootName = subsidiaries?.[0]?.name ?? '—'
        return (
          <>
            <Label>{label}</Label>
            {isEditable && !isPosted ? (
              <SearchSelect
                options={subsidiaryOpts}
                value={subsidiaryId}
                onChange={(v) => setSubsidiaryId(v ?? '')}
                clearable
                emptyLabel={rootName}
                placeholder={rootName}
              />
            ) : (<p className="text-sm">{subsidiaryId ? subsidiaryName(subsidiaryId) : rootName}</p>)}
          </>
        )
      }
      case 'payment_hold_reason':
        return (
          <>
            <Label>{label}</Label>
            {isEditable ? (
              <Input value={paymentHoldReason} onChange={(e) => setPaymentHoldReason(e.target.value)} />
            ) : (<p className="text-sm">{doc.payment_hold_reason ?? '—'}</p>)}
          </>
        )
      case 'internal_notes':
        return (
          <>
            <Label>{label}</Label>
            {isEditable ? (
              <Input value={internalNotes} onChange={(e) => setInternalNotes(e.target.value)} />
            ) : (<p className="text-sm">{doc.internal_notes ?? '—'}</p>)}
          </>
        )
      case 'billing_method':
        return (
          <>
            <Label>{label}</Label>
            {isEditable ? (
              <Select value={billingMethod} onChange={(e) => setBillingMethod(e.target.value)}>
                <option value="">—</option>
                <option value="time_and_materials">{tCommon('billingMethods.timeAndMaterials')}</option>
                <option value="fixed_price">{tCommon('billingMethods.fixedPrice')}</option>
              </Select>
            ) : (
              <p className="text-sm">
                {doc.billing_method === 'time_and_materials' ? tCommon('billingMethods.timeAndMaterials') : doc.billing_method === 'fixed_price' ? tCommon('billingMethods.fixedPrice') : '—'}
              </p>
            )}
          </>
        )
      case 'is_final_invoice':
        return (
          <>
            <Label>{label}</Label>
            {isEditable ? (
              <label className="flex h-9 items-center gap-2 text-sm">
                <input type="checkbox" checked={isFinalInvoice} onChange={(e) => setIsFinalInvoice(e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500" />
                {tCommon('labels.finalInvoice')}
              </label>
            ) : (<p className="text-sm">{doc.is_final_invoice ? tCommon('labels.yes') : tCommon('labels.no')}</p>)}
          </>
        )
      default:
        if (isCustomFieldKey(p.key)) {
          const defKey = customFieldDefKey(p.key)
          const def = headerDefByDefKey.get(defKey)
          if (!def) return null
          // The other agent's <CustomFieldInput> renders its own Label + control
          // + help text (and honours displayMode/readOnly), so the layout cell
          // only contributes the col-span placement. A labelOverride on the
          // placement is applied by swapping the def's label for this render.
          const fieldDef = p.labelOverride?.trim()
            ? { ...def, label: p.labelOverride.trim(), isRequired: p.required === true ? true : def.isRequired }
            : p.required === true
              ? { ...def, isRequired: true }
              : def
          return (
            <CustomFieldInput
              def={fieldDef}
              value={customValues[defKey]}
              onChange={(v) => setCustomValues((c) => ({ ...c, [defKey]: v }))}
              readOnly={!isEditable}
            />
          )
        }
        return null
    }
  }

  // Per-record "Custom Form" picker (view mode) — switch the form layout for
  // this record, optionally set it as the user's preferred form.
  async function setPreferredForm(layoutId: string | null) {
    if (!recordType) return
    const res = await fetch('/api/customization/form-preferences', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recordType, layoutId }),
    })
    if (res.ok) toast.success(layoutId ? t('drawer.formSetPreferredDone') : t('drawer.formPreferredCleared'))
    else toast.error((await res.json()).error ?? t('drawer.formPreferredFailed'))
  }
  const showFormPicker = !editable && !!availableLayouts && availableLayouts.length > 0 && !!recordType

  // Deep link into the form designer for this record type — straight to the
  // active layout when one is applied, otherwise the record type's forms tab.
  const customizeHref =
    canCustomize && recordType
      ? `/admin/customization?recordType=${encodeURIComponent(recordType)}&tab=forms${currentLayoutId ? `&form=${currentLayoutId}` : ''}`
      : null

  const actionLayout = layout?.actions ?? FORM_ACTION_KEYS.map((key) => ({ key, visible: true }))
  const renderFormAction = (key: string) => {
    switch (key) {
      case 'customize':
        return customizeHref ? (
          <Button variant="ghost" asChild>
            <Link href={customizeHref}>{tCommon('actions.customize')}</Link>
          </Button>
        ) : null
      case 'pdf':
        return PDF_RECORD_TYPE_BY_KEY[recordType ?? String(doc.kind)] ? (
          <PdfButton recordType={recordType ?? String(doc.kind)} recordId={String(doc.id)} />
        ) : null
      case 'workflow':
        return <FlowManualButtons subjectKind={String(doc.kind)} subjectId={String(doc.id)} />
      case 'approval':
        return doc.status === 'pending_approval' ? (
          <ApprovalActions subjectKind={String(doc.kind)} subjectId={String(doc.id)} />
        ) : null
      case 'submit':
        return isDraft && canCreate && !config.directPost ? (
          <Button disabled={busy || (config.partyRole ? !partyId : false) || !positiveAmount(totals.total)} onClick={() => act('submit')}>
            {t('actions.submitForApproval')}
          </Button>
        ) : null
      case 'post':
        return (isDraft && canCreate && config.directPost) || (doc.status === 'approved' && canPost) ? (
          <Button disabled={busy || (isDraft && !positiveAmount(totals.total))} onClick={() => act('post')}>
            {tCommon('actions.post')}
          </Button>
        ) : null
      case 'gl_impact':
        return doc.entry_id ? (
          <Button variant="outline" asChild>
            <Link href={`/journal/${doc.entry_id}`}>{t('drawer.viewGlImpact')}</Link>
          </Button>
        ) : null
      case 'delete':
        return doc.status !== 'voided' && canCreate ? (
          <Button variant="ghost" disabled={busy} onClick={remove} className="text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950/40">
            {tCommon('actions.delete')}
          </Button>
        ) : null
      default:
        return null
    }
  }

  return (
    <TransactionDrawer
      closeHref={basePath}
      recordId={String(doc.id)}
      canEditAttachments={canCreate}
      panelClassName={docTypeMeta(config.kind).surfaceCls}
      title={
        <span className="flex items-center gap-2.5">
          <DocTypeBadge kind={config.kind} />
          <span className="font-mono">{doc.document_number}</span>
          <Badge variant={STATUS_VARIANT[displayStatus] ?? 'secondary'}>
            {STATUS_KEYS[displayStatus]
              ? tCommon(`status.${STATUS_KEYS[displayStatus]}`)
              : String(displayStatus).replace('_', ' ')}
          </Badge>
        </span>
      }
      description={mode === 'edit' ? t('drawer.editingHint') : (doc.party_name ?? undefined)}
      primaryAction={
        mode === 'view' && canEditStatus ? (
          <Button variant="outline" size="sm" className="h-8 px-2.5 text-xs" onClick={() => setMode('edit')}>
            {tCommon('actions.edit')}
          </Button>
        ) : null
      }
      actionsMenuHeader={showFormPicker ? (
        <div className="mb-1.5 space-y-1.5 border-b border-slate-100 px-1 pb-2 dark:border-slate-800">
          <span className="block text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
            {t('drawer.formLabel')}
          </span>
          <Select
            value={currentLayoutId ?? ''}
            onChange={(e) => router.push(`${basePath}?doc=${doc.id}&form=${e.target.value}`)}
            aria-label={t('drawer.formLabel')}
            triggerClassName="!h-8 !min-h-0 !px-2 !py-0 !text-xs"
          >
            {availableLayouts!.map((availableLayout) => (
              <option key={availableLayout.id} value={availableLayout.id}>{availableLayout.name}</option>
            ))}
          </Select>
          <Button
            variant="ghost"
            size="sm"
            className="!h-8 w-full !justify-start !px-2 !text-xs"
            onClick={() => setPreferredForm(currentLayoutId ?? null)}
            disabled={!currentLayoutId}
          >
            {t('drawer.formSetPreferred')}
          </Button>
        </div>
      ) : null}
      actions={
        mode === 'edit' ? (
          <>
            {actionLayout.find((action) => action.key === 'customize')?.visible ? renderFormAction('customize') : null}
            <Button disabled={busy} onClick={save}>
              {busy ? tCommon('actions.saving') : tCommon('actions.save')}
            </Button>
            <Button variant="outline" disabled={busy} onClick={cancel}>
              {tCommon('actions.cancel')}
            </Button>
          </>
        ) : (
          <>
            {actionLayout.filter((action) => action.visible && action.key !== 'edit').map((action) => (
              <Fragment key={action.key}>{renderFormAction(action.key)}</Fragment>
            ))}
          </>
        )
      }
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
                  ? t('drawer.saveState.error')
                  : dirty
                    ? t('drawer.saveState.dirty')
                    : null
              : null}
          </span>
          <span className="flex-1" />
          <span className="text-sm text-slate-600 tabular-nums dark:text-slate-300">
            {t('drawer.subtotalAmount', { amount: money(totals.subtotal) })}
            {config.hasTax ? <> · {t('drawer.taxTotalAmount', { amount: money(totals.taxTotal) })}</> : null}
            {' · '}
            <strong className="text-slate-900 dark:text-slate-100">
              {t('drawer.totalAmount', { amount: money(totals.total) })}
            </strong>
            {isPosted && config.showsBalance ? (
              <>
                {' · '}
                <strong className="text-slate-900 dark:text-slate-100">
                  {t('drawer.balanceDueAmount', { amount: money(doc.balance_due) })}
                </strong>
              </>
            ) : null}
          </span>
        </div>
      }
    >
      <div className="space-y-6 p-1">
        {isTransfer ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className={field}>
              <Label>{t('drawer.transferAmount')}{editable ? <span className="text-red-500"> *</span> : null}</Label>
              {editable ? <Input type="number" step="0.01" value={transfer?.amount ?? ''} onChange={(e) => setTransfer((p) => ({ ...p!, amount: e.target.value }))} /> : <p className="text-sm tabular-nums">{money(payload.lines[0]?.amount)}</p>}
            </div>
            <div className={field}>
              <Label>{t('drawer.toAccount')}{editable ? <span className="text-red-500"> *</span> : null}</Label>
              {editable ? <SearchSelect options={(bankAccounts ?? accounts).map((a) => ({ value: a.id, label: `${a.number ?? ''} ${a.name ?? ''}`.trim() }))} value={transfer?.toAccount ?? ''} onChange={(v) => setTransfer((p) => ({ ...p!, toAccount: v ?? '' }))} placeholder={t('drawer.accountPlaceholder')} /> : <p className="text-sm">{accountName(payload.lines[0]?.account_id)}</p>}
            </div>
            <div className={field}>
              <Label>{t('drawer.fromAccount')}{editable ? <span className="text-red-500"> *</span> : null}</Label>
              {editable ? <SearchSelect options={(bankAccounts ?? accounts).map((a) => ({ value: a.id, label: `${a.number ?? ''} ${a.name ?? ''}`.trim() }))} value={transfer?.fromAccount ?? ''} onChange={(v) => setTransfer((p) => ({ ...p!, fromAccount: v ?? '' }))} placeholder={t('drawer.accountPlaceholder')} /> : <p className="text-sm">{accountName(payload.lines[1]?.account_id)}</p>}
            </div>
          </div>
        ) : null}

        {config.kind === 'deposit' ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className={field}>
              <Label>{t('drawer.depositTo')}{editable ? <span className="text-red-500"> *</span> : null}</Label>
              {editable ? <SearchSelect options={(bankAccounts ?? accounts).map((a) => ({ value: a.id, label: `${a.number ?? ''} ${a.name ?? ''}`.trim() }))} value={(customValues.controlAccountId as string) ?? ''} onChange={(v) => setCustomValues((c) => ({ ...c, controlAccountId: v ?? '' }))} placeholder={t('drawer.accountPlaceholder')} /> : <p className="text-sm">{accountName(customValues.controlAccountId as string)}</p>}
            </div>
          </div>
        ) : null}

        {useLayout ? (
          <>
            <HeaderFields layout={layout!} editable={editable} renderField={renderHeaderField} />
            {multiSub && !layoutShowsSubsidiary ? (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <div className={field}>{renderHeaderField({ key: 'subsidiary_id', visible: true }, editable)}</div>
              </div>
            ) : null}
          </>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {config.partyRole ? (
                <div className={`${field} lg:col-span-2`}>
                  <Label>{partyLabel}{editable ? <span className="text-red-500"> *</span> : null}</Label>
                  {editable ? (
                    <SearchSelect
                      options={(parties ?? []).map((p) => ({ value: p.id, label: p.display_name ?? '' }))}
                      value={partyId}
                      onChange={changeParty}
                      placeholder={partyPlaceholder}
                    />
                  ) : (
                    <p className="text-sm">{doc.party_name}</p>
                  )}
                </div>
              ) : null}

              {config.fundingSource === 'card' ? (
                <div className={`${field} lg:col-span-2`}>
                  <Label>{t('drawer.card')}{editable ? <span className="text-red-500"> *</span> : null}</Label>
                  {editable ? (
                    <SearchSelect
                      options={(cards ?? []).map((c) => ({ value: c.id, label: c.display_name ?? c.label ?? '' }))}
                      value={paymentCardId}
                      onChange={(v) => setPaymentCardId(v ?? '')}
                      placeholder={t('drawer.selectCardPlaceholder')}
                    />
                  ) : (
                    <p className="text-sm">
                      {(cards ?? []).find((c) => c.id === doc.payment_card_id)?.display_name ?? doc.payment_card_id ?? '—'}
                    </p>
                  )}
                </div>
              ) : null}

              {multiSub ? (
                <div className={field}>{renderHeaderField({ key: 'subsidiary_id', visible: true }, editable)}</div>
              ) : null}

              <div className={field}>
                <Label>{t('drawer.dateLabel')}</Label>
                {editable ? (
                  <Input type="date" value={documentDate} onChange={(e) => setDocumentDate(e.target.value)} />
                ) : (
                  <p className="text-sm">{doc.document_date}</p>
                )}
              </div>
              {config.hasDueDate ? (
                <div className={field}>
                  <Label>{t('drawer.dueDate')}</Label>
                  {editable ? (
                    <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
                  ) : (
                    <p className="text-sm">{doc.due_date ?? '—'}</p>
                  )}
                </div>
              ) : null}
              {config.hasReference ? (
                <div className={field}>
                  <Label>{t('drawer.reference')}</Label>
                  {editable ? (
                    <Input value={referenceNumber} onChange={(e) => setReferenceNumber(e.target.value)} />
                  ) : (
                    <p className="text-sm">{doc.reference_number ?? '—'}</p>
                  )}
                </div>
              ) : null}
              <div className={`${field} lg:col-span-3`}>
                <Label>{tCommon('labels.memo')}</Label>
                {editable ? (
                  <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
                ) : (
                  <p className="text-sm">{doc.memo ?? '—'}</p>
                )}
              </div>
            </div>

            <CustomFieldInputs defs={headerDefs} values={customValues} onChange={setCustomValues} readOnly={!editable} />
          </>
        )}

        {segments.some((segment) => segment.showOnHeader) ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {segments.filter((segment) => segment.showOnHeader).map((segment) => {
              const selected = extraDims[segment.key] ?? ''
              const selectedLabel = segment.values.find((value) => value.id === selected)
              return (
                <div className={field} key={segment.key}>
                  <Label>{segment.name}</Label>
                  {editable ? (
                    <SearchSelect
                      options={segment.values.map((value) => ({
                        value: value.id,
                        label: `${value.code ? `${value.code} · ` : ''}${value.name}`,
                      }))}
                      value={selected}
                      onChange={(value) => setExtraDims((current) => ({ ...current, [segment.key]: value ?? '' }))}
                      placeholder="—"
                    />
                  ) : (
                    <p className="text-sm">{selectedLabel?.name ?? '—'}</p>
                  )}
                </div>
              )
            })}
          </div>
        ) : null}

        {!isTransfer ? (
          <div className="space-y-2">
            <Label>{tCommon('labels.lines')}</Label>
            <LineGrid<LineRow>
              columns={useLayout ? columnsFromLayout : columns}
              rows={rows}
              onRowsChange={setRows}
              emptyRow={emptyLine}
              readOnly={!editable}
            />
          </div>
        ) : null}

        {mode === 'view' ? (
          // source platform "Workflow History" parity: the record's approval timeline
          // (flows + legacy policy engine). Renders nothing when empty.
          <ApprovalHistory subjectKind={String(doc.kind)} subjectId={String(doc.id)} />
        ) : null}

      </div>
    </TransactionDrawer>
  )
}

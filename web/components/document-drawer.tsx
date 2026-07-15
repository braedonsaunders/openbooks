'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Badge, Button, Input, Label, SearchSelect, Select, UrlDrawer } from '@openbooks/ui'
import { LineGrid, type LineGridColumn } from './line-grid'
import { CustomFieldInputs, customFieldColumns, type CustomFieldDefClient } from './custom-field-inputs'
import { CustomFieldInput } from './custom-field-input'
import { HeaderFields } from './transaction-form/header-fields'
import { AttachmentPanel } from './attachment-panel'
import { DocTypeBadge } from './doc-type-badge'
import { money } from '../lib/format'
import { confirmDialog } from '../lib/confirm'
import type { DocKindConfig } from '../lib/document-kinds'
import {
  type FormLayoutConfig,
  type HeaderFieldPlacement,
  type LineColumnPlacement,
  customFieldDefKey,
  isCustomFieldKey,
  lineFieldMeta,
} from '@openbooks/customization'

interface Opt {
  id: string
  display_name?: string
  number?: string
  name?: string
  code?: string
  rate?: string
  label?: string
}
interface LineRow extends Record<string, unknown> {
  accountId: string
  description: string
  departmentId: string
  projectId: string
  taxCodeId: string
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
  description: '',
  departmentId: '',
  projectId: '',
  taxCodeId: '',
  amount: '',
  taxOverridden: false,
  taxAmount: '',
})

function toRow(l: Record<string, any>, lineDefs: CustomFieldDefClient[]): LineRow {
  const row: LineRow = {
    accountId: l.account_id ?? '',
    description: l.description ?? '',
    departmentId: l.department_id ?? '',
    projectId: l.project_id ?? '',
    taxCodeId: l.tax_code_id ?? '',
    amount: l.amount != null ? Number(l.amount).toFixed(2) : '',
    taxOverridden: l.tax_overridden === true,
    taxAmount: l.tax_amount != null ? Number(l.tax_amount).toFixed(2) : '',
  }
  for (const def of lineDefs) row[`cf_${def.key}`] = (l.custom ?? {})[def.key] ?? ''
  return row
}

export interface DocumentDrawerProps {
  payload: DocPayload
  config: DocKindConfig
  basePath: string
  parties?: Opt[]
  accounts: Opt[]
  taxCodes?: Opt[]
  cards?: Opt[]
  bankAccounts?: Opt[]
  departments: Opt[]
  projects: Opt[]
  headerDefs: CustomFieldDefClient[]
  lineDefs: CustomFieldDefClient[]
  canCreate: boolean
  canPost: boolean
  /** Resolved transaction form layout (vendor_bill today); when present the
   *  header + line columns render from it (move/hide/rename/custom fields).
   *  Omitted ⇒ the hardcoded header + columns (all other kinds). */
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
  cards,
  bankAccounts,
  departments,
  projects,
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
  // Record flyouts ALWAYS open read-only (NetSuite view-mode model); editing
  // is an explicit Edit → Save/Cancel cycle from the header.
  const [mode, setMode] = useState<'view' | 'edit'>('view')
  const editable = mode === 'edit' && canEditStatus
  // Posted open-item docs that carry a balance resolve to open/paid from the
  // applications ledger (invoices). Credits post open items too but their
  // "applied" flows the opposite direction, so they show their raw status.
  const displayStatus = isPosted && config.showsBalance
    ? Number(doc.balance_due) > 0
      ? 'open'
      : 'paid'
    : doc.status

  const [partyId, setPartyId] = useState<string>(doc.party_id ?? '')
  const [paymentCardId, setPaymentCardId] = useState<string>(doc.payment_card_id ?? '')
  const [documentDate, setDocumentDate] = useState<string>(doc.document_date ?? '')
  const [dueDate, setDueDate] = useState<string>(doc.due_date ?? '')
  const [referenceNumber, setReferenceNumber] = useState<string>(doc.reference_number ?? '')
  const [memo, setMemo] = useState<string>(doc.memo ?? '')
  const [customValues, setCustomValues] = useState<Record<string, unknown>>(doc.custom ?? {})

  // -- transfer: dedicated to/from + amount state ---------------------------
  const initialTransfer = isTransfer
    ? {
        toAccount: payload.lines[0]?.account_id ?? '',
        fromAccount: payload.lines[1]?.account_id ?? '',
        amount: payload.lines[0]?.amount != null ? Number(payload.lines[0].amount).toFixed(2) : '',
      }
    : null
  const [transfer, setTransfer] = useState(initialTransfer)

  const [rows, setRows] = useState<LineRow[]>(
    payload.lines.length > 0 ? payload.lines.map((l) => toRow(l, lineDefs)) : [emptyLine()],
  )
  const [totals, setTotals] = useState({ subtotal: doc.subtotal, taxTotal: doc.tax_total, total: doc.total })
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'dirty' | 'error'>('saved')
  const [busy, setBusy] = useState(false)

  const rateByCode = useMemo(
    () => new Map((taxCodes ?? []).map((tc) => [tc.id, Number(tc.rate ?? 0)])),
    [taxCodes],
  )
  const lineTax = (row: LineRow) => {
    const rate = row.taxCodeId ? (rateByCode.get(row.taxCodeId) ?? 0) : 0
    const amt = Number(row.amount)
    if (!rate || Number.isNaN(amt)) return 0
    return Math.round(amt * rate) / 100
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
        custom: customValues,
        lines: transfer
          ? [
              { accountId: transfer.toAccount, amount: transfer.amount, description: null },
              { accountId: transfer.fromAccount, amount: transfer.amount, description: null },
            ].filter((l) => l.accountId && Number(l.amount) > 0)
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
      custom: customValues,
      lines: rows
        .filter((r) => r.accountId && Number(r.amount) > 0)
        .map((r) => ({
          accountId: r.accountId,
          description: r.description,
          amount: r.amount,
          taxCodeId: config.hasTax ? r.taxCodeId || null : null,
          taxOverridden: config.hasTax ? r.taxOverridden : false,
          taxAmount: config.hasTax && r.taxOverridden ? r.taxAmount : null,
          departmentId: r.departmentId || null,
          projectId: r.projectId || null,
          custom: Object.fromEntries(
            lineDefs.map((d) => [d.key, r[`cf_${d.key}`]]).filter(([, v]) => v !== '' && v != null),
          ),
        })),
    }
  }, [isTransfer, transfer, partyId, paymentCardId, documentDate, dueDate, referenceNumber, memo, customValues, rows, lineDefs, config])

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
    setCustomValues(doc.custom ?? {})
    setTransfer(initialTransfer)
    setRows(payload.lines.length > 0 ? payload.lines.map((l) => toRow(l, lineDefs)) : [emptyLine()])
    setTotals({ subtotal: doc.subtotal, taxTotal: doc.tax_total, total: doc.total })
  }

  async function save() {
    setBusy(true)
    setSaveState('saving')
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
        key: 'taxCodeId',
        label: tCommon('labels.tax'),
        width: '110px',
        type: 'select',
        options: [{ value: '', label: t('drawer.noTax') }, ...(taxCodes ?? []).map((tc) => ({ value: tc.id, label: tc.code ?? '' }))],
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
    return cols
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts, departments, projects, taxCodes, lineDefs, config, t, tCommon])

  const field = 'space-y-1.5'
  const accountName = (id: unknown): string => {
    if (!id) return '—'
    const a = (bankAccounts ?? accounts).find((x) => x.id === id) ?? accounts.find((x) => x.id === id)
    return a ? `${a.number ?? ''} ${a.name ?? ''}`.trim() : String(id)
  }
  const partyLabel = config.partyRole === 'customer' ? tCommon('labels.customer') : tCommon('labels.vendor')
  const partyPlaceholder = config.partyRole === 'customer' ? t('drawer.selectCustomerPlaceholder') : t('drawer.selectVendorPlaceholder')

  // -- layout-driven path (vendor_bill today): header via <HeaderFields> + line
  //    columns from the resolved FormLayoutConfig. Falls back to the hardcoded
  //    `columns`/grid above for every other kind (no layout passed). ----------
  const useLayout = !!layout && !isTransfer

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
      description: { key: 'description', width: 'minmax(160px,1.6fr)', type: 'text' },
      department_id: {
        key: 'departmentId', width: '140px', type: 'select',
        options: [{ value: '', label: '—' }, ...departments.map((d) => ({ value: d.id, label: d.name ?? '' }))],
      },
      project_id: {
        key: 'projectId', width: 'minmax(150px,1.2fr)', type: 'search-select',
        options: projects.map((p) => ({ value: p.id, label: p.name ?? '' })), placeholder: '—',
      },
      tax_code_id: {
        key: 'taxCodeId', width: '110px', type: 'select',
        options: [{ value: '', label: t('drawer.noTax') }, ...(taxCodes ?? []).map((tc) => ({ value: tc.id, label: tc.code ?? '' }))],
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
      description: tCommon('labels.description'),
      department_id: tCommon('labels.department'),
      project_id: tCommon('labels.project'),
      tax_code_id: tCommon('labels.tax'),
      amount: tCommon('labels.amount'),
      tax_amount: t('drawer.taxAmountColumn'),
    }
    return layout.lines.columns
      .filter((p: LineColumnPlacement) => p.visible)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, accounts, departments, projects, taxCodes, lineDefs, cfColumns, columns, recordType, t, tCommon])

  const headerDefByDefKey = useMemo(() => new Map(headerDefs.map((d) => [d.key, d])), [headerDefs])
  const defLabelForHeader = (key: string): string => {
    switch (key) {
      case 'party_id': return partyLabel
      case 'payment_card_id': return t('drawer.card')
      case 'document_date': return t('drawer.dateLabel')
      case 'due_date': return t('drawer.dueDate')
      case 'reference_number': return t('drawer.reference')
      case 'memo': return tCommon('labels.memo')
      default:
        if (isCustomFieldKey(key)) return headerDefByDefKey.get(customFieldDefKey(key))?.label ?? key
        return key
    }
  }

  const renderHeaderField = (p: HeaderFieldPlacement, isEditable: boolean): React.ReactNode => {
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
                onChange={(v) => setPartyId(v ?? '')}
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
    if (res.ok) toast.success(layoutId ? t('drawer.formSetPreferred') : t('drawer.formPreferredCleared'))
    else toast.error((await res.json()).error ?? t('drawer.formPreferredFailed'))
  }
  const showFormPicker = !editable && !!availableLayouts && availableLayouts.length > 0 && !!recordType

  // Deep link into the form designer for this record type — straight to the
  // active layout when one is applied, otherwise the record type's forms tab.
  const customizeHref =
    canCustomize && recordType
      ? `/admin/customization?recordType=${encodeURIComponent(recordType)}&tab=forms${currentLayoutId ? `&form=${currentLayoutId}` : ''}`
      : null

  return (
    <UrlDrawer
      open
      closeHref={basePath}
      size="2xl"
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
      headerActions={
        <>
          {customizeHref ? (
            <Button variant="ghost" asChild>
              <Link href={customizeHref}>{tCommon('actions.customize')}</Link>
            </Button>
          ) : null}
          {mode === 'edit' ? (
            <>
              <Button disabled={busy} onClick={save}>
                {busy ? tCommon('actions.saving') : tCommon('actions.save')}
              </Button>
              <Button variant="outline" disabled={busy} onClick={cancel}>
                {tCommon('actions.cancel')}
              </Button>
            </>
          ) : (
            <>
              {canEditStatus ? (
                <Button variant="outline" onClick={() => setMode('edit')}>
                  {tCommon('actions.edit')}
                </Button>
              ) : null}
              {isDraft && canCreate && !config.directPost ? (
                <Button disabled={busy || (config.partyRole ? !partyId : false) || Number(totals.total) <= 0} onClick={() => act('submit')}>
                  {t('actions.submitForApproval')}
                </Button>
              ) : null}
              {isDraft && canCreate && config.directPost ? (
                <Button disabled={busy || Number(totals.total) <= 0} onClick={() => act('post')}>
                  {tCommon('actions.post')}
                </Button>
              ) : null}
              {doc.status === 'approved' && canPost ? (
                <Button disabled={busy} onClick={() => act('post')}>
                  {tCommon('actions.post')}
                </Button>
              ) : null}
              {doc.entry_id ? (
                <Button variant="outline" asChild>
                  <Link href={`/journal/${doc.entry_id}`}>{t('drawer.viewGlImpact')}</Link>
                </Button>
              ) : null}
              {doc.status !== 'voided' && canCreate ? (
                <Button variant="ghost" disabled={busy} onClick={remove} className="text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950/40">
                  {tCommon('actions.delete')}
                </Button>
              ) : null}
            </>
          )}
        </>
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
        {showFormPicker ? (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-800 dark:bg-slate-900/50">
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">{t('drawer.formLabel')}</span>
            <div className="w-52">
              <Select
                value={currentLayoutId ?? ''}
                onChange={(e) => router.push(e.target.value ? `${basePath}?doc=${doc.id}&form=${e.target.value}` : `${basePath}?doc=${doc.id}`)}
              >
                <option value="">{t('drawer.formDefault')}</option>
                {availableLayouts!.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </Select>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setPreferredForm(currentLayoutId ?? null)} disabled={!currentLayoutId}>
              {t('drawer.formSetPreferred')}
            </Button>
          </div>
        ) : null}

        {useLayout ? (
          <HeaderFields layout={layout!} editable={editable} renderField={renderHeaderField} />
        ) : (
          <>
            {isTransfer ? (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <div className={field}>
                  <Label>{t('drawer.transferAmount')}{editable ? <span className="text-red-500"> *</span> : null}</Label>
                  {editable ? (
                    <Input type="number" step="0.01" value={transfer?.amount ?? ''} onChange={(e) => setTransfer((p) => ({ ...p!, amount: e.target.value }))} />
                  ) : (
                    <p className="text-sm tabular-nums">{money(payload.lines[0]?.amount)}</p>
                  )}
                </div>
                <div className={`${field} lg:col-span-1`}>
                  <Label>{t('drawer.toAccount')}{editable ? <span className="text-red-500"> *</span> : null}</Label>
                  {editable ? (
                    <SearchSelect
                      options={(bankAccounts ?? accounts).map((a) => ({ value: a.id, label: `${a.number ?? ''} ${a.name ?? ''}`.trim() }))}
                      value={transfer?.toAccount ?? ''}
                      onChange={(v) => setTransfer((p) => ({ ...p!, toAccount: v ?? '' }))}
                      placeholder={t('drawer.accountPlaceholder')}
                    />
                  ) : (
                    <p className="text-sm">{accountName(payload.lines[0]?.account_id)}</p>
                  )}
                </div>
                <div className={`${field} lg:col-span-1`}>
                  <Label>{t('drawer.fromAccount')}{editable ? <span className="text-red-500"> *</span> : null}</Label>
                  {editable ? (
                    <SearchSelect
                      options={(bankAccounts ?? accounts).map((a) => ({ value: a.id, label: `${a.number ?? ''} ${a.name ?? ''}`.trim() }))}
                      value={transfer?.fromAccount ?? ''}
                      onChange={(v) => setTransfer((p) => ({ ...p!, fromAccount: v ?? '' }))}
                      placeholder={t('drawer.accountPlaceholder')}
                    />
                  ) : (
                    <p className="text-sm">{accountName(payload.lines[1]?.account_id)}</p>
                  )}
                </div>
              </div>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {config.partyRole ? (
                <div className={`${field} lg:col-span-2`}>
                  <Label>{partyLabel}{editable ? <span className="text-red-500"> *</span> : null}</Label>
                  {editable ? (
                    <SearchSelect
                      options={(parties ?? []).map((p) => ({ value: p.id, label: p.display_name ?? '' }))}
                      value={partyId}
                      onChange={(v) => setPartyId(v ?? '')}
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

        <AttachmentPanel targetTable="documents" targetId={doc.id} canEdit />
      </div>
    </UrlDrawer>
  )
}

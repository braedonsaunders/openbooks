'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { useTranslations } from 'next-intl'
import { Badge, Button, Input, Label, SearchSelect, UrlDrawer } from '@openbooks/ui'
import { LineGrid, type LineGridColumn } from '../../../components/line-grid'
import { CustomFieldInputs, customFieldColumns, type CustomFieldDefClient } from '../../../components/custom-field-inputs'
import { AttachmentPanel } from '../../../components/attachment-panel'
import { DocTypeBadge } from '../../../components/doc-type-badge'
import { money } from '../../../lib/format'
import { confirmDialog } from '../../../lib/confirm'

interface Opt {
  id: string
  display_name?: string
  number?: string
  name?: string
  code?: string
  rate?: string
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
interface InvoicePayload {
  doc: Record<string, any>
  lines: Record<string, any>[]
}

const STATUS_VARIANT: Record<string, 'default' | 'success' | 'secondary' | 'warning' | 'outline'> = {
  open: 'default',
  paid: 'success',
  approved: 'success',
  pending_approval: 'warning',
  draft: 'secondary',
  voided: 'outline',
}

/** DB status/bucket value → `common.status.*` message key. Unknown values render verbatim. */
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

export function InvoiceDrawer({
  invoice,
  customers,
  accounts,
  taxCodes,
  departments,
  projects,
  headerDefs,
  lineDefs,
}: {
  invoice: InvoicePayload
  customers: Opt[]
  accounts: Opt[]
  taxCodes: Opt[]
  departments: Opt[]
  projects: Opt[]
  headerDefs: CustomFieldDefClient[]
  lineDefs: CustomFieldDefClient[]
}) {
  const t = useTranslations('ar')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const doc = invoice.doc
  const isDraft = doc.status === 'draft'
  const isPosted = doc.status === 'posted'
  // NetSuite-style record model: the flyout opens READ-ONLY (view mode) with an
  // Edit button; a brand-new draft opens straight into edit. Draft, approved,
  // and POSTED invoices are all editable — saving a posted invoice
  // re-materializes its GL-Impact projection (the server blocks only GL changes
  // into a closed period). pending_approval and voided invoices are read-only.
  // Save is EXPLICIT — one Save button, no per-field autosave.
  const canEditStatus = doc.status === 'draft' || doc.status === 'approved' || doc.status === 'posted'
  const [mode, setMode] = useState<'view' | 'edit'>(isDraft ? 'edit' : 'view')
  const editable = mode === 'edit' && canEditStatus
  // Posted invoices resolve to open/paid from the applications ledger state.
  const displayStatus = isPosted ? (Number(doc.balance_due) > 0 ? 'open' : 'paid') : doc.status

  const [partyId, setPartyId] = useState<string>(doc.party_id ?? '')
  const [documentDate, setDocumentDate] = useState<string>(doc.document_date ?? '')
  const [dueDate, setDueDate] = useState<string>(doc.due_date ?? '')
  const [referenceNumber, setReferenceNumber] = useState<string>(doc.reference_number ?? '')
  const [memo, setMemo] = useState<string>(doc.memo ?? '')
  const [customValues, setCustomValues] = useState<Record<string, unknown>>(doc.custom ?? {})
  const [rows, setRows] = useState<LineRow[]>(
    invoice.lines.length > 0 ? invoice.lines.map((l) => toRow(l, lineDefs)) : [emptyLine()],
  )
  const [totals, setTotals] = useState({ subtotal: doc.subtotal, taxTotal: doc.tax_total, total: doc.total })
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'dirty' | 'error'>('saved')
  const [busy, setBusy] = useState(false)

  const rateByCode = useMemo(() => new Map(taxCodes.map((t) => [t.id, Number(t.rate ?? 0)])), [taxCodes])
  const lineTax = (row: LineRow) => {
    const rate = row.taxCodeId ? (rateByCode.get(row.taxCodeId) ?? 0) : 0
    const amt = Number(row.amount)
    if (!rate || Number.isNaN(amt)) return 0
    return Math.round(amt * rate) / 100
  }

  // -- explicit save (no autosave) -----------------------------------------
  const payload = useMemo(
    () => ({
      partyId: partyId || null,
      documentDate: documentDate || undefined,
      dueDate: dueDate || null,
      referenceNumber,
      memo,
      custom: customValues,
      lines: rows
        .filter((r) => r.accountId && Number(r.amount) > 0)
        .map((r) => ({
          accountId: r.accountId,
          description: r.description,
          amount: r.amount,
          taxCodeId: r.taxCodeId || null,
          taxOverridden: r.taxOverridden,
          taxAmount: r.taxOverridden ? r.taxAmount : null,
          departmentId: r.departmentId || null,
          projectId: r.projectId || null,
          custom: Object.fromEntries(
            lineDefs.map((d) => [d.key, r[`cf_${d.key}`]]).filter(([, v]) => v !== '' && v != null),
          ),
        })),
    }),
    [partyId, documentDate, dueDate, referenceNumber, memo, customValues, rows, lineDefs],
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
    setReferenceNumber(doc.reference_number ?? '')
    setMemo(doc.memo ?? '')
    setCustomValues(doc.custom ?? {})
    setRows(invoice.lines.length > 0 ? invoice.lines.map((l) => toRow(l, lineDefs)) : [emptyLine()])
    setTotals({ subtotal: doc.subtotal, taxTotal: doc.tax_total, total: doc.total })
  }

  async function save() {
    setBusy(true)
    setSaveState('saving')
    const res = await fetch(`/api/invoices/${doc.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (res.ok) {
      const data = (await res.json()) as InvoicePayload
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
    const res = await fetch('/api/invoices/actions', {
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
    const posted = doc.status === 'posted'
    if (
      !(await confirmDialog({
        title: 'Delete this invoice?',
        message: posted
          ? 'This permanently deletes the invoice and removes its ledger impact. This cannot be undone.'
          : 'This permanently deletes the draft invoice. This cannot be undone.',
        confirmLabel: 'Delete',
        tone: 'danger',
      }))
    )
      return
    setBusy(true)
    const res = await fetch(`/api/invoices/${doc.id}`, { method: 'DELETE' })
    if (res.ok) {
      toast.success('Invoice deleted')
      router.push('/ar')
      router.refresh()
    } else {
      toast.error((await res.json()).error ?? 'Delete failed')
      setBusy(false)
    }
  }

  // -- grid columns ----------------------------------------------------------
  const columns = useMemo<LineGridColumn<LineRow>[]>(
    () => [
      {
        key: 'accountId',
        label: t('drawer.columns.incomeAccount'),
        width: 'minmax(200px,2fr)',
        type: 'search-select',
        required: true,
        options: accounts.map((a) => ({ value: a.id, label: `${a.number ?? ''} ${a.name ?? ''}`.trim() })),
        placeholder: t('drawer.columns.accountPlaceholder'),
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
      {
        key: 'taxCodeId',
        label: tCommon('labels.tax'),
        width: '110px',
        type: 'select',
        options: [{ value: '', label: t('drawer.columns.noTax') }, ...taxCodes.map((tc) => ({ value: tc.id, label: tc.code ?? '' }))],
      },
      ...customFieldColumns<LineRow>(lineDefs),
      { key: 'amount', label: tCommon('labels.amount'), width: '120px', type: 'amount', align: 'right', required: true },
      {
        key: 'taxAmount',
        label: t('drawer.columns.taxAmount'),
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
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accounts, departments, projects, taxCodes, lineDefs, t, tCommon],
  )

  const field = 'space-y-1.5'

  return (
    <UrlDrawer
      open
      closeHref="/ar"
      size="2xl"
      title={
        <span className="flex items-center gap-2.5">
          <DocTypeBadge kind="customer_invoice" />
          <span className="font-mono">{doc.document_number}</span>
          <Badge variant={STATUS_VARIANT[displayStatus] ?? 'secondary'}>
            {STATUS_KEYS[displayStatus]
              ? tCommon(`status.${STATUS_KEYS[displayStatus]}`)
              : String(displayStatus).replace('_', ' ')}
          </Badge>
        </span>
      }
      description={mode === 'edit' ? 'Editing — Save to apply changes' : (doc.customer_name ?? undefined)}
      headerActions={
        <>
          {mode === 'edit' ? (
            <>
              <Button disabled={busy} onClick={save}>
                {busy ? 'Saving…' : 'Save'}
              </Button>
              <Button variant="outline" disabled={busy} onClick={cancel}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              {canEditStatus ? (
                <Button variant="outline" onClick={() => setMode('edit')}>
                  Edit
                </Button>
              ) : null}
              {isDraft ? (
                <Button disabled={busy || !partyId || Number(totals.total) <= 0} onClick={() => act('submit')}>
                  {t('actions.submitForApproval')}
                </Button>
              ) : null}
              {doc.status === 'approved' ? (
                <Button disabled={busy} onClick={() => act('post')}>
                  {tCommon('actions.post')}
                </Button>
              ) : null}
              {doc.entry_id ? (
                <Button variant="outline" asChild>
                  <Link href={`/journal/${doc.entry_id}`}>{t('drawer.viewGlImpact')}</Link>
                </Button>
              ) : null}
              {doc.status !== 'voided' ? (
                <Button variant="ghost" disabled={busy} onClick={remove} className="text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950/40">
                  Delete
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
                  ? t('drawer.saveFailedRetry')
                  : dirty
                    ? t('drawer.unsavedChanges')
                    : null
              : null}
          </span>
          <span className="flex-1" />
          <span className="text-sm text-slate-600 tabular-nums dark:text-slate-300">
            {t('drawer.subtotalAmount', { amount: money(totals.subtotal) })} ·{' '}
            {t('drawer.taxTotalAmount', { amount: money(totals.taxTotal) })} ·{' '}
            <strong className="text-slate-900 dark:text-slate-100">
              {t('drawer.totalAmount', { amount: money(totals.total) })}
            </strong>
            {isPosted ? (
              <>
                {' '}
                ·{' '}
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
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className={`${field} lg:col-span-2`}>
            <Label>{tCommon('labels.customer')}{editable ? <span className="text-red-500"> *</span> : null}</Label>
            {editable ? (
              <SearchSelect
                options={customers.map((c) => ({ value: c.id, label: c.display_name ?? '' }))}
                value={partyId}
                onChange={(v) => setPartyId(v ?? '')}
                placeholder={t('drawer.selectCustomerPlaceholder')}
              />
            ) : (
              <p className="text-sm">{doc.customer_name}</p>
            )}
          </div>
          <div className={field}>
            <Label>{t('drawer.invoiceDate')}</Label>
            {editable ? (
              <Input type="date" value={documentDate} onChange={(e) => setDocumentDate(e.target.value)} />
            ) : (
              <p className="text-sm">{doc.document_date}</p>
            )}
          </div>
          <div className={field}>
            <Label>{t('drawer.dueDate')}</Label>
            {editable ? (
              <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            ) : (
              <p className="text-sm">{doc.due_date ?? '—'}</p>
            )}
          </div>
          <div className={field}>
            <Label>{t('drawer.customerRef')}</Label>
            {editable ? (
              <Input value={referenceNumber} onChange={(e) => setReferenceNumber(e.target.value)} />
            ) : (
              <p className="text-sm">{doc.reference_number ?? '—'}</p>
            )}
          </div>
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

        <div className="space-y-2">
          <Label>{tCommon('labels.lines')}</Label>
          <LineGrid<LineRow>
            columns={columns}
            rows={rows}
            onRowsChange={setRows}
            emptyRow={emptyLine}
            readOnly={!editable}
          />
        </div>

        <AttachmentPanel targetTable="documents" targetId={doc.id} canEdit />
      </div>
    </UrlDrawer>
  )
}

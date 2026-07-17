'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Wand2 } from 'lucide-react'
import { Badge, Button, Input, Label, SearchSelect } from '@openbooks/ui'
import { AttachmentPanel } from '../../../components/attachment-panel'
import { TransactionDrawer } from '../../../components/transaction-drawer'
import { DocTypeBadge, docTypeMeta } from '../../../components/doc-type-badge'
import { PdfButton } from '../../../components/pdf-button'
import { money } from '../../../lib/format'
import { confirmDialog } from '../../../lib/confirm'
import { HeaderFields } from '../../../components/transaction-form/header-fields'
import type { FormLayoutConfig, HeaderFieldPlacement } from '@openbooks/customization'

/**
 * Shared payment/receipt flyout. side='ap' → vendor payment applying open
 * bills; side='ar' → customer receipt applying open invoices. Drafts
 * autosave; "Pay & post" / "Receive & post" is the explicit kernel action.
 */

interface Opt {
  id: string
  display_name?: string
  number?: string | null
  name?: string
}

export interface OpenItemClient {
  lineId: string
  entryNumber: string
  postingDate: string
  dueDate: string | null
  documentNumber: string | null
  documentKind: string | null
  referenceNumber: string | null
  amount: string
  applied: string
  open: string
}

export interface PaymentPayload {
  doc: Record<string, any>
  bankAccountId: string | null
  allocations: { openLineId: string; amount: string }[]
  applied: Record<string, any>[]
}

const STATUS_VARIANT: Record<string, 'success' | 'secondary' | 'warning' | 'outline'> = {
  posted: 'success',
  approved: 'success',
  pending_approval: 'warning',
  draft: 'secondary',
  voided: 'outline',
}

// document kind enum → payments.drawer.kind.* message keys (fallback: 'entry').
const KIND_KEY: Record<string, string> = {
  vendor_bill: 'vendorBill',
  customer_invoice: 'customerInvoice',
  expense_report: 'expenseReport',
  journal: 'journal',
}

// documents.status enum → common.status.* message keys (fallback: raw value).
const STATUS_LABEL_KEY: Record<string, string> = {
  draft: 'draft',
  pending_approval: 'pendingApproval',
  approved: 'approved',
  rejected: 'rejected',
  posted: 'posted',
  paid: 'paid',
  partially_paid: 'partiallyPaid',
  voided: 'voided',
  reversed: 'reversed',
  cancelled: 'cancelled',
}

export function PaymentDrawer({
  payment,
  initialOpenItems,
  parties,
  bankAccounts,
  side,
  basePath,
  layout,
}: {
  payment: PaymentPayload
  initialOpenItems: OpenItemClient[]
  parties: Opt[]
  bankAccounts: Opt[]
  side: 'ap' | 'ar'
  basePath: string
  layout?: FormLayoutConfig
}) {
  const t = useTranslations('payments.drawer')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const doc = payment.doc
  const isDraft = doc.status === 'draft'
  // NetSuite-style record model: the flyout ALWAYS opens READ-ONLY (view mode)
  // — even for drafts — with an Edit button in the header. Only DRAFT payments
  // are editable (posting is terminal — applications become ledger state). Save
  // is EXPLICIT — one Save button, no per-field autosave.
  const canEditStatus = isDraft
  const [mode, setMode] = useState<'view' | 'edit'>('view')
  const editable = mode === 'edit' && canEditStatus
  const partyLabel = side === 'ap' ? tCommon('labels.vendor') : tCommon('labels.customer')
  const kindLabel = (kind: string | null) => {
    const key = KIND_KEY[kind ?? '']
    return key ? t(`kind.${key}`) : t('kind.entry')
  }
  const statusLabel = (status: string) => {
    const key = STATUS_LABEL_KEY[status]
    return key ? tCommon(`status.${key}`) : status.replace('_', ' ')
  }

  const [partyId, setPartyId] = useState<string>(doc.party_id ?? '')
  const [bankAccountId, setBankAccountId] = useState<string>(payment.bankAccountId ?? '')
  const [documentDate, setDocumentDate] = useState<string>(doc.document_date ?? '')
  const [referenceNumber, setReferenceNumber] = useState<string>(doc.reference_number ?? '')
  // Optional target for Auto-apply (AR receipts); does not change the posting —
  // the payment total is always the sum of what's actually applied.
  const [receivedAmount, setReceivedAmount] = useState<string>('')
  const [memo, setMemo] = useState<string>(doc.memo ?? '')
  const [openItems, setOpenItems] = useState<OpenItemClient[]>(initialOpenItems)
  const [loadingItems, setLoadingItems] = useState(false)
  const [allocs, setAllocs] = useState<Record<string, string>>(() =>
    Object.fromEntries(payment.allocations.map((a) => [a.openLineId, Number(a.amount).toFixed(2)])),
  )
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'dirty' | 'error'>('saved')
  const [busy, setBusy] = useState(false)

  // -- open items follow the selected party --------------------------------
  const firstParty = useRef(true)
  useEffect(() => {
    if (!isDraft) return
    if (firstParty.current) {
      firstParty.current = false
      return
    }
    setAllocs({})
    if (!partyId) {
      setOpenItems([])
      return
    }
    let cancelled = false
    setLoadingItems(true)
    fetch(`/api/payments/open-items?partyId=${partyId}&side=${side}`)
      .then(async (res) => {
        const data = await res.json()
        if (cancelled) return
        if (!res.ok) toast.error(data.error ?? t('toasts.loadOpenItemsFailed'))
        else setOpenItems(data.items ?? [])
      })
      .finally(() => {
        if (!cancelled) setLoadingItems(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partyId, side, isDraft])

  const rowValid = (item: OpenItemClient) => {
    const v = allocs[item.lineId]
    if (v === undefined) return true
    const n = Number(v)
    return Number.isFinite(n) && n > 0 && n <= Number(item.open) + 1e-9
  }
  const validAllocations = useMemo(
    () =>
      openItems
        .filter((i) => allocs[i.lineId] !== undefined && rowValid(i) && Number(allocs[i.lineId]) > 0)
        .map((i) => ({ openLineId: i.lineId, amount: Number(allocs[i.lineId]).toFixed(2) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allocs, openItems],
  )
  const hasInvalidRow = openItems.some((i) => !rowValid(i))
  const total = validAllocations.reduce((acc, a) => acc + Number(a.amount), 0)

  // -- explicit save (no autosave) -----------------------------------------
  const payload = useMemo(
    () => ({
      partyId: partyId || null,
      bankAccountId: bankAccountId || null,
      documentDate: documentDate || undefined,
      referenceNumber,
      memo,
      allocations: validAllocations,
    }),
    [partyId, bankAccountId, documentDate, referenceNumber, memo, validAllocations],
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
    setBankAccountId(payment.bankAccountId ?? '')
    setDocumentDate(doc.document_date ?? '')
    setReferenceNumber(doc.reference_number ?? '')
    setMemo(doc.memo ?? '')
    setAllocs(Object.fromEntries(payment.allocations.map((a) => [a.openLineId, Number(a.amount).toFixed(2)])))
  }

  async function save() {
    setBusy(true)
    setSaveState('saving')
    const res = await fetch(`/api/payments/${doc.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (res.ok) {
      setSaveState('saved')
      setDirty(false)
      setMode('view')
      router.refresh()
    } else {
      setSaveState('error')
      toast.error((await res.json()).error ?? t('toasts.postFailed'))
    }
    setBusy(false)
  }

  function cancel() {
    resetForm()
    setDirty(false)
    setSaveState('saved')
    setMode('view')
  }

  async function post() {
    setBusy(true)
    const res = await fetch('/api/payments/post-with-applications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId: doc.id, allocations: validAllocations }),
    })
    const data = await res.json()
    if (!res.ok) toast.error(data.error ?? t('toasts.postFailed'))
    else toast.success(t('toasts.posted', { side }))
    setBusy(false)
    router.refresh()
  }

  async function remove() {
    const posted = doc.status !== 'draft'
    if (
      !(await confirmDialog({
        title: 'Delete this payment?',
        message: posted
          ? 'This permanently deletes the payment, removes its ledger impact, and reopens any items it applied to. This cannot be undone.'
          : 'This permanently deletes the draft payment. This cannot be undone.',
        confirmLabel: 'Delete',
        tone: 'danger',
      }))
    )
      return
    setBusy(true)
    const res = await fetch(`/api/payments/${doc.id}`, { method: 'DELETE' })
    if (res.ok) {
      toast.success('Payment deleted')
      router.push(basePath)
      router.refresh()
    } else {
      toast.error((await res.json()).error ?? 'Delete failed')
      setBusy(false)
    }
  }

  function toggle(item: OpenItemClient) {
    setAllocs((prev) => {
      const next = { ...prev }
      if (next[item.lineId] === undefined) next[item.lineId] = Number(item.open).toFixed(2)
      else delete next[item.lineId]
      return next
    })
  }

  // Automated cash application: ask the engine to spread the received amount
  // across the party's open items (reference → exact → FIFO) and fill the rows.
  async function autoApply() {
    if (!partyId) return
    const amount = receivedAmount.trim() || openItems.reduce((a, i) => a + Number(i.open), 0).toFixed(2)
    setBusy(true)
    try {
      const res = await fetch('/api/payments/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ partyId, amount, side, reference: referenceNumber || null }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error ?? t('autoApplyFailed'))
        return
      }
      if (!data.allocations?.length) {
        toast.info(t('autoApplyNone'))
        return
      }
      setAllocs(Object.fromEntries(data.allocations.map((a: any) => [a.openLineId, Number(a.amount).toFixed(2)])))
      toast.success(t('autoApplyDone', { count: data.allocations.length, strategy: t(`autoApplyStrategy.${data.strategy}`) }))
    } finally {
      setBusy(false)
    }
  }

  const field = 'space-y-1.5'
  const renderHeaderField = (placement: HeaderFieldPlacement, isEditable: boolean) => {
    const label = placement.labelOverride?.trim()
    switch (placement.key) {
      case 'party_id':
        return <><Label>{label || partyLabel}{isEditable ? <span className="text-red-500"> *</span> : null}</Label>{isEditable ? <SearchSelect options={parties.map((party) => ({ value: party.id, label: party.display_name ?? '' }))} value={partyId} onChange={(value) => setPartyId(value ?? '')} placeholder={t('selectPartyPlaceholder', { side })} /> : <p className="text-sm">{doc.party_name}</p>}</>
      case 'bank_account_id':
        return <><Label>{label || t('bankAccount')}{isEditable ? <span className="text-red-500"> *</span> : null}</Label>{isEditable ? <SearchSelect options={bankAccounts.map((account) => ({ value: account.id, label: `${account.number ?? ''} ${account.name ?? ''}`.trim() }))} value={bankAccountId} onChange={(value) => setBankAccountId(value ?? '')} placeholder={t('selectBankAccountPlaceholder')} /> : <p className="text-sm">{`${doc.bank_account_number ?? ''} ${doc.bank_account_name ?? ''}`.trim() || '—'}</p>}</>
      case 'document_date':
        return <><Label>{label || tCommon('labels.date')}</Label>{isEditable ? <Input type="date" value={documentDate} onChange={(event) => setDocumentDate(event.target.value)} /> : <p className="text-sm">{doc.document_date}</p>}</>
      case 'reference_number':
        return <><Label>{label || tCommon('labels.reference')}</Label>{isEditable ? <Input value={referenceNumber} onChange={(event) => setReferenceNumber(event.target.value)} placeholder={t('referencePlaceholder')} /> : <p className="text-sm">{doc.reference_number ?? '—'}</p>}</>
      case 'memo':
        return <><Label>{label || tCommon('labels.memo')}</Label>{isEditable ? <Input value={memo} onChange={(event) => setMemo(event.target.value)} /> : <p className="text-sm">{doc.memo ?? '—'}</p>}</>
      default:
        return null
    }
  }
  const canPost =
    isDraft &&
    !busy &&
    !hasInvalidRow &&
    !dirty &&
    !!partyId &&
    !!bankAccountId &&
    validAllocations.length > 0 &&
    total > 0

  return (
    <TransactionDrawer
      closeHref={basePath}
      panelClassName={docTypeMeta(String(doc.kind ?? (side === 'ap' ? 'vendor_payment' : 'customer_payment'))).surfaceCls}
      title={
        <span className="flex items-center gap-2.5">
          <DocTypeBadge kind={String(doc.kind ?? (side === 'ap' ? 'vendor_payment' : 'customer_payment'))} />
          <span className="font-mono">{doc.document_number}</span>
          <Badge variant={STATUS_VARIANT[doc.status] ?? 'secondary'}>
            {statusLabel(String(doc.status))}
          </Badge>
        </span>
      }
      description={mode === 'edit' ? tCommon('feedback.editingHint') : (doc.party_name ?? undefined)}
      primaryAction={
        mode === 'view' && canEditStatus ? (
          <Button variant="outline" size="sm" className="h-8 px-2.5 text-xs" onClick={() => setMode('edit')}>
            {tCommon('actions.edit')}
          </Button>
        ) : null
      }
      actions={
        <>
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
              <PdfButton
                recordType={String(doc.kind ?? (side === 'ap' ? 'vendor_payment' : 'customer_payment'))}
                recordId={String(doc.id)}
              />
              {isDraft ? (
                <Button disabled={!canPost} onClick={post}>
                  {busy ? tCommon('actions.posting') : t('postAction', { side })}
                </Button>
              ) : null}
              {doc.entry_id ? (
                <Button variant="outline" asChild>
                  <Link href={`/journal/${doc.entry_id}`}>{t('viewGlImpact')}</Link>
                </Button>
              ) : null}
              {doc.status !== 'voided' ? (
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
                  ? t('saveState.error')
                  : dirty
                    ? t('saveState.dirty')
                    : null
              : null}
          </span>
          <span className="flex-1" />
          <span className="text-sm text-slate-600 tabular-nums dark:text-slate-300">
            {isDraft ? (
              t.rich('applyingSummary', {
                count: validAllocations.length,
                amount: money(total),
                total: (chunks) => (
                  <strong className="text-slate-900 dark:text-slate-100">{chunks}</strong>
                ),
              })
            ) : (
              <strong className="text-slate-900 dark:text-slate-100">
                {t('totalAmount', { amount: money(doc.total) })}
              </strong>
            )}
          </span>
        </div>
      }
    >
      <div className="space-y-6 p-1">
        {layout ? <HeaderFields layout={layout} editable={editable} renderField={renderHeaderField} /> : <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className={`${field} lg:col-span-2`}>
            <Label>
              {partyLabel}
              {editable ? <span className="text-red-500"> *</span> : null}
            </Label>
            {editable ? (
              <SearchSelect
                options={parties.map((p) => ({ value: p.id, label: p.display_name ?? '' }))}
                value={partyId}
                onChange={(v) => setPartyId(v ?? '')}
                placeholder={t('selectPartyPlaceholder', { side })}
              />
            ) : (
              <p className="text-sm">{doc.party_name}</p>
            )}
          </div>
          <div className={`${field} lg:col-span-2`}>
            <Label>
              {t('bankAccount')}
              {editable ? <span className="text-red-500"> *</span> : null}
            </Label>
            {editable ? (
              <SearchSelect
                options={bankAccounts.map((a) => ({
                  value: a.id,
                  label: `${a.number ?? ''} ${a.name ?? ''}`.trim(),
                }))}
                value={bankAccountId}
                onChange={(v) => setBankAccountId(v ?? '')}
                placeholder={t('selectBankAccountPlaceholder')}
              />
            ) : (
              <p className="text-sm">
                {`${doc.bank_account_number ?? ''} ${doc.bank_account_name ?? ''}`.trim() || '—'}
              </p>
            )}
          </div>
          <div className={field}>
            <Label>{tCommon('labels.date')}</Label>
            {editable ? (
              <Input type="date" value={documentDate} onChange={(e) => setDocumentDate(e.target.value)} />
            ) : (
              <p className="text-sm">{doc.document_date}</p>
            )}
          </div>
          <div className={field}>
            <Label>{tCommon('labels.reference')}</Label>
            {editable ? (
              <Input
                value={referenceNumber}
                onChange={(e) => setReferenceNumber(e.target.value)}
                placeholder={t('referencePlaceholder')}
              />
            ) : (
              <p className="text-sm">{doc.reference_number ?? '—'}</p>
            )}
          </div>
          <div className={`${field} lg:col-span-2`}>
            <Label>{tCommon('labels.memo')}</Label>
            {editable ? (
              <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
            ) : (
              <p className="text-sm">{doc.memo ?? '—'}</p>
            )}
          </div>
        </div>}

        {isDraft ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label>{t('openItems', { side })}</Label>
              {editable && partyId && openItems.length > 0 ? (
                <div className="flex items-center gap-2">
                  {side === 'ar' ? (
                    <Input
                      inputMode="decimal"
                      value={receivedAmount}
                      onChange={(e) => setReceivedAmount(e.target.value)}
                      placeholder={t('amountReceived')}
                      className="h-8 w-32 text-right tabular-nums"
                    />
                  ) : null}
                  <Button variant="outline" size="sm" disabled={busy} onClick={autoApply}>
                    <Wand2 size={14} /> {t('autoApply')}
                  </Button>
                </div>
              ) : null}
            </div>
            {!partyId ? (
              <p className="rounded-md border border-dashed border-slate-300 px-3 py-6 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
                {t('selectPartyHint', { side })}
              </p>
            ) : loadingItems ? (
              <p className="px-3 py-6 text-center text-sm text-slate-500 dark:text-slate-400">{t('loadingOpenItems')}</p>
            ) : openItems.length === 0 ? (
              <p className="rounded-md border border-dashed border-slate-300 px-3 py-6 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
                {t('noOpenItems', { side })}
              </p>
            ) : (
              <div className="overflow-x-auto rounded-md border border-slate-200 dark:border-slate-800">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
                      <th className="w-10 px-3 py-2" aria-label={t('columns.apply')} />
                      <th className="px-3 py-2">{t('columns.document')}</th>
                      <th className="px-3 py-2">{t('columns.due')}</th>
                      <th className="px-3 py-2 text-right">{t('columns.original')}</th>
                      <th className="px-3 py-2 text-right">{t('columns.appliedToDate')}</th>
                      <th className="px-3 py-2 text-right">{t('columns.open')}</th>
                      <th className="w-36 px-3 py-2 text-right">{t('columns.apply')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {openItems.map((item) => {
                      const checked = allocs[item.lineId] !== undefined
                      const invalid = !rowValid(item)
                      return (
                        <tr
                          key={item.lineId}
                          className="border-b border-slate-100 last:border-0 dark:border-slate-800/60"
                        >
                          <td className="px-3 py-2">
                            <input
                              type="checkbox"
                              className="h-4 w-4 accent-teal-600"
                              checked={checked}
                              disabled={!editable}
                              onChange={() => toggle(item)}
                              aria-label={t('applyAriaLabel', { document: item.documentNumber ?? item.entryNumber })}
                            />
                          </td>
                          <td className="px-3 py-2">
                            <span className="font-mono text-[13px] font-semibold">
                              {item.documentNumber ?? item.entryNumber}
                            </span>
                            <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">
                              {kindLabel(item.documentKind)}
                              {item.referenceNumber ? ` · ${item.referenceNumber}` : ''}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-slate-600 dark:text-slate-300">{item.dueDate ?? '—'}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{money(item.amount)}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">
                            {money(item.applied)}
                          </td>
                          <td className="px-3 py-2 text-right font-medium tabular-nums">{money(item.open)}</td>
                          <td className="px-3 py-2">
                            {checked ? (
                              <Input
                                inputMode="decimal"
                                className={
                                  'h-8 text-right tabular-nums ' +
                                  (invalid ? 'border-red-400 focus-visible:ring-red-400 dark:border-red-600' : '')
                                }
                                value={allocs[item.lineId]}
                                disabled={!editable}
                                onChange={(e) =>
                                  setAllocs((prev) => ({ ...prev, [item.lineId]: e.target.value }))
                                }
                                aria-invalid={invalid}
                              />
                            ) : null}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {hasInvalidRow ? (
              <p className="text-xs text-red-600 dark:text-red-400">{t('invalidAllocation')}</p>
            ) : null}
          </div>
        ) : (
          <div className="space-y-2">
            <Label>{t('appliedTo')}</Label>
            {payment.applied.length === 0 ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">
                {doc.status === 'voided' ? t('voidedNote') : t('noLiveApplications')}
              </p>
            ) : (
              <div className="overflow-x-auto rounded-md border border-slate-200 dark:border-slate-800">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
                      <th className="px-3 py-2">{t('columns.document')}</th>
                      <th className="px-3 py-2">{t('columns.due')}</th>
                      <th className="px-3 py-2">{t('columns.appliedOn')}</th>
                      <th className="px-3 py-2 text-right">{t('columns.original')}</th>
                      <th className="px-3 py-2 text-right">{t('columns.applied')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payment.applied.map((a) => (
                      <tr key={a.id} className="border-b border-slate-100 last:border-0 dark:border-slate-800/60">
                        <td className="px-3 py-2">
                          <span className="font-mono text-[13px] font-semibold">
                            {a.target_document_number ?? a.target_entry_number}
                          </span>
                          <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">
                            {kindLabel(a.target_document_kind)}
                            {a.target_reference_number ? ` · ${a.target_reference_number}` : ''}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-slate-600 dark:text-slate-300">{a.target_due_date ?? '—'}</td>
                        <td className="px-3 py-2 text-slate-600 dark:text-slate-300">{a.applied_on}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{money(a.target_amount)}</td>
                        <td className="px-3 py-2 text-right font-medium tabular-nums">{money(a.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        <AttachmentPanel targetTable="documents" targetId={doc.id} canEdit />
      </div>
    </TransactionDrawer>
  )
}

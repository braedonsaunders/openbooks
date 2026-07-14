'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Badge, Button, Input, Label, SearchSelect, UrlDrawer } from '@openbooks/ui'
import { AttachmentPanel } from '../../../components/attachment-panel'
import { money } from '../../../lib/format'

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

const KIND_LABEL: Record<string, string> = {
  vendor_bill: 'Bill',
  customer_invoice: 'Invoice',
  expense_report: 'Expense report',
  journal: 'Journal',
}

export function PaymentDrawer({
  payment,
  initialOpenItems,
  parties,
  bankAccounts,
  side,
  basePath,
}: {
  payment: PaymentPayload
  initialOpenItems: OpenItemClient[]
  parties: Opt[]
  bankAccounts: Opt[]
  side: 'ap' | 'ar'
  basePath: string
}) {
  const router = useRouter()
  const doc = payment.doc
  const isDraft = doc.status === 'draft'
  const L =
    side === 'ap'
      ? { party: 'Vendor', items: 'Open bills', post: 'Pay & post', empty: 'No open bills for this vendor.' }
      : { party: 'Customer', items: 'Open invoices', post: 'Receive & post', empty: 'No open invoices for this customer.' }

  const [partyId, setPartyId] = useState<string>(doc.party_id ?? '')
  const [bankAccountId, setBankAccountId] = useState<string>(payment.bankAccountId ?? '')
  const [documentDate, setDocumentDate] = useState<string>(doc.document_date ?? '')
  const [referenceNumber, setReferenceNumber] = useState<string>(doc.reference_number ?? '')
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
        if (!res.ok) toast.error(data.error ?? 'Could not load open items')
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

  // -- autosave (drafts only) ----------------------------------------------
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
  const first = useRef(true)
  useEffect(() => {
    if (!isDraft) return
    if (first.current) {
      first.current = false
      return
    }
    setSaveState('dirty')
    const t = setTimeout(async () => {
      setSaveState('saving')
      const res = await fetch(`/api/payments/${doc.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (res.ok) {
        setSaveState('saved')
        router.refresh()
      } else {
        setSaveState('error')
        toast.error((await res.json()).error ?? 'Autosave failed')
      }
    }, 600)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload, isDraft])

  async function post() {
    setBusy(true)
    const res = await fetch('/api/payments/post-with-applications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId: doc.id, allocations: validAllocations }),
    })
    const data = await res.json()
    if (!res.ok) toast.error(data.error ?? 'Posting failed')
    else toast.success(side === 'ap' ? 'Payment posted and applied' : 'Receipt posted and applied')
    setBusy(false)
    router.refresh()
  }

  function toggle(item: OpenItemClient) {
    setAllocs((prev) => {
      const next = { ...prev }
      if (next[item.lineId] === undefined) next[item.lineId] = Number(item.open).toFixed(2)
      else delete next[item.lineId]
      return next
    })
  }

  const field = 'space-y-1.5'
  const canPost =
    isDraft &&
    !busy &&
    !hasInvalidRow &&
    saveState === 'saved' &&
    !!partyId &&
    !!bankAccountId &&
    validAllocations.length > 0 &&
    total > 0

  return (
    <UrlDrawer
      open
      closeHref={basePath}
      size="2xl"
      title={
        <span className="flex items-center gap-2.5">
          <span className="font-mono">{doc.document_number}</span>
          <Badge variant={STATUS_VARIANT[doc.status] ?? 'secondary'}>
            {String(doc.status).replace('_', ' ')}
          </Badge>
        </span>
      }
      description={isDraft ? 'Draft — changes save automatically.' : (doc.party_name ?? undefined)}
      footer={
        <div className="flex w-full items-center gap-3">
          <span
            className={
              'text-xs ' +
              (saveState === 'error' ? 'text-red-600 dark:text-red-400' : 'text-slate-500 dark:text-slate-400')
            }
          >
            {isDraft
              ? saveState === 'saved'
                ? 'All changes saved'
                : saveState === 'saving'
                  ? 'Saving…'
                  : saveState === 'error'
                    ? 'Save failed — fix and retry'
                    : 'Unsaved changes…'
              : null}
          </span>
          <span className="flex-1" />
          <span className="text-sm text-slate-600 tabular-nums dark:text-slate-300">
            {isDraft ? (
              <>
                Applying {validAllocations.length} item{validAllocations.length === 1 ? '' : 's'} ·{' '}
                <strong className="text-slate-900 dark:text-slate-100">Total {money(total)}</strong>
              </>
            ) : (
              <strong className="text-slate-900 dark:text-slate-100">Total {money(doc.total)}</strong>
            )}
          </span>
          {isDraft ? (
            <Button disabled={!canPost} onClick={post}>
              {busy ? 'Posting…' : L.post}
            </Button>
          ) : null}
          {doc.entry_id ? (
            <Button variant="outline" asChild>
              <Link href={`/journal/${doc.entry_id}`}>View GL impact</Link>
            </Button>
          ) : null}
        </div>
      }
    >
      <div className="space-y-6 p-1">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className={`${field} lg:col-span-2`}>
            <Label>
              {L.party}
              {isDraft ? <span className="text-red-500"> *</span> : null}
            </Label>
            {isDraft ? (
              <SearchSelect
                options={parties.map((p) => ({ value: p.id, label: p.display_name ?? '' }))}
                value={partyId}
                onChange={(v) => setPartyId(v ?? '')}
                placeholder={`Select ${L.party.toLowerCase()}…`}
              />
            ) : (
              <p className="text-sm">{doc.party_name}</p>
            )}
          </div>
          <div className={`${field} lg:col-span-2`}>
            <Label>
              Bank account{isDraft ? <span className="text-red-500"> *</span> : null}
            </Label>
            {isDraft ? (
              <SearchSelect
                options={bankAccounts.map((a) => ({
                  value: a.id,
                  label: `${a.number ?? ''} ${a.name ?? ''}`.trim(),
                }))}
                value={bankAccountId}
                onChange={(v) => setBankAccountId(v ?? '')}
                placeholder="Select bank account…"
              />
            ) : (
              <p className="text-sm">
                {`${doc.bank_account_number ?? ''} ${doc.bank_account_name ?? ''}`.trim() || '—'}
              </p>
            )}
          </div>
          <div className={field}>
            <Label>Date</Label>
            {isDraft ? (
              <Input type="date" value={documentDate} onChange={(e) => setDocumentDate(e.target.value)} />
            ) : (
              <p className="text-sm">{doc.document_date}</p>
            )}
          </div>
          <div className={field}>
            <Label>Reference</Label>
            {isDraft ? (
              <Input
                value={referenceNumber}
                onChange={(e) => setReferenceNumber(e.target.value)}
                placeholder="Cheque / EFT ref…"
              />
            ) : (
              <p className="text-sm">{doc.reference_number ?? '—'}</p>
            )}
          </div>
          <div className={`${field} lg:col-span-2`}>
            <Label>Memo</Label>
            {isDraft ? (
              <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
            ) : (
              <p className="text-sm">{doc.memo ?? '—'}</p>
            )}
          </div>
        </div>

        {isDraft ? (
          <div className="space-y-2">
            <Label>{L.items}</Label>
            {!partyId ? (
              <p className="rounded-md border border-dashed border-slate-300 px-3 py-6 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
                Select a {L.party.toLowerCase()} to list their open items.
              </p>
            ) : loadingItems ? (
              <p className="px-3 py-6 text-center text-sm text-slate-500 dark:text-slate-400">Loading open items…</p>
            ) : openItems.length === 0 ? (
              <p className="rounded-md border border-dashed border-slate-300 px-3 py-6 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
                {L.empty}
              </p>
            ) : (
              <div className="overflow-x-auto rounded-md border border-slate-200 dark:border-slate-800">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
                      <th className="w-10 px-3 py-2" aria-label="Apply" />
                      <th className="px-3 py-2">Document</th>
                      <th className="px-3 py-2">Due</th>
                      <th className="px-3 py-2 text-right">Original</th>
                      <th className="px-3 py-2 text-right">Applied to date</th>
                      <th className="px-3 py-2 text-right">Open</th>
                      <th className="w-36 px-3 py-2 text-right">Apply</th>
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
                              onChange={() => toggle(item)}
                              aria-label={`Apply to ${item.documentNumber ?? item.entryNumber}`}
                            />
                          </td>
                          <td className="px-3 py-2">
                            <span className="font-mono text-[13px] font-semibold">
                              {item.documentNumber ?? item.entryNumber}
                            </span>
                            <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">
                              {KIND_LABEL[item.documentKind ?? ''] ?? 'Entry'}
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
              <p className="text-xs text-red-600 dark:text-red-400">
                Each applied amount must be greater than zero and no more than the item&apos;s open balance.
              </p>
            ) : null}
          </div>
        ) : (
          <div className="space-y-2">
            <Label>Applied to</Label>
            {payment.applied.length === 0 ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">
                {doc.status === 'voided'
                  ? 'This payment was voided; its posting was reversed.'
                  : 'No live applications.'}
              </p>
            ) : (
              <div className="overflow-x-auto rounded-md border border-slate-200 dark:border-slate-800">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
                      <th className="px-3 py-2">Document</th>
                      <th className="px-3 py-2">Due</th>
                      <th className="px-3 py-2">Applied on</th>
                      <th className="px-3 py-2 text-right">Original</th>
                      <th className="px-3 py-2 text-right">Applied</th>
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
                            {KIND_LABEL[a.target_document_kind ?? ''] ?? 'Entry'}
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
    </UrlDrawer>
  )
}

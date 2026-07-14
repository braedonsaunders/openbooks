'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge, Button, Input, Label, SearchSelect, Select, UrlDrawer, cn } from '@openbooks/ui'
import { money } from '../../../lib/format'

interface Opt {
  id: string
  display_name?: string
  number?: string
  name?: string
  code?: string
}
interface LineState {
  accountId: string
  description: string
  amount: string
  taxCodeId: string
}
interface BillPayload {
  doc: Record<string, any>
  lines: Record<string, any>[]
}

const STATUS_VARIANT: Record<string, 'success' | 'secondary' | 'warning' | 'outline'> = {
  posted: 'success',
  approved: 'success',
  pending_approval: 'warning',
  draft: 'secondary',
  voided: 'outline',
}

/**
 * The AP bill flyout — create (instant draft), edit (autosave), and view.
 * Drafts autosave ~600ms after the last change; posting/submitting are
 * explicit actions. Non-draft bills render read-only with lifecycle actions.
 */
export function BillDrawer({
  bill,
  vendors,
  accounts,
  taxCodes,
  canApprove,
}: {
  bill: BillPayload
  vendors: Opt[]
  accounts: Opt[]
  taxCodes: Opt[]
  canApprove: boolean
}) {
  const router = useRouter()
  const doc = bill.doc
  const isDraft = doc.status === 'draft'

  const [partyId, setPartyId] = useState<string>(doc.party_id ?? '')
  const [documentDate, setDocumentDate] = useState<string>(doc.document_date ?? '')
  const [dueDate, setDueDate] = useState<string>(doc.due_date ?? '')
  const [referenceNumber, setReferenceNumber] = useState<string>(doc.reference_number ?? '')
  const [memo, setMemo] = useState<string>(doc.memo ?? '')
  const [lines, setLines] = useState<LineState[]>(
    bill.lines.length > 0
      ? bill.lines.map((l) => ({
          accountId: l.account_id ?? '',
          description: l.description ?? '',
          amount: String(Number(l.amount ?? 0) || ''),
          taxCodeId: l.tax_code_id ?? '',
        }))
      : [{ accountId: '', description: '', amount: '', taxCodeId: '' }],
  )
  const [totals, setTotals] = useState({ subtotal: doc.subtotal, taxTotal: doc.tax_total, total: doc.total })
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'dirty'>('saved')
  const [busy, setBusy] = useState(false)

  // -- autosave (drafts only) ----------------------------------------------
  const payload = useMemo(
    () => ({
      partyId: partyId || null,
      documentDate: documentDate || undefined,
      dueDate: dueDate || null,
      referenceNumber,
      memo,
      lines: lines
        .filter((l) => l.accountId && Number(l.amount) > 0)
        .map((l) => ({ ...l, taxCodeId: l.taxCodeId || null })),
    }),
    [partyId, documentDate, dueDate, referenceNumber, memo, lines],
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
      const res = await fetch(`/api/bills/${doc.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (res.ok) {
        const data = (await res.json()) as BillPayload
        setTotals({ subtotal: data.doc.subtotal, taxTotal: data.doc.tax_total, total: data.doc.total })
        setSaveState('saved')
        router.refresh()
      } else {
        setSaveState('dirty')
        toast.error((await res.json()).error ?? 'Autosave failed')
      }
    }, 600)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload, isDraft])

  const setLine = (i: number, patch: Partial<LineState>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)))

  async function act(action: 'submit' | 'post' | 'decide', extra?: Record<string, unknown>) {
    setBusy(true)
    const res = await fetch('/api/bills/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, documentId: doc.id, ...extra }),
    })
    const data = await res.json()
    if (!res.ok) toast.error(data.error ?? 'Action failed')
    else toast.success(action === 'submit' ? 'Submitted for approval' : 'Posted to the ledger')
    setBusy(false)
    router.refresh()
  }

  const field = 'space-y-1.5'

  return (
    <UrlDrawer
      open
      closeHref="/ap"
      size="xl"
      title={
        <span className="flex items-center gap-2.5">
          <span className="font-mono">{doc.document_number}</span>
          <Badge variant={STATUS_VARIANT[doc.status] ?? 'secondary'}>
            {String(doc.status).replace('_', ' ')}
          </Badge>
        </span>
      }
      description={isDraft ? 'Draft — changes save automatically.' : (doc.vendor_name ?? undefined)}
      footer={
        <div className="flex w-full items-center gap-3">
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {isDraft ? (saveState === 'saved' ? 'All changes saved' : saveState === 'saving' ? 'Saving…' : 'Unsaved changes…') : null}
          </span>
          <span className="flex-1" />
          <span className="text-sm text-slate-600 tabular-nums dark:text-slate-300">
            Subtotal {money(totals.subtotal)} · Tax {money(totals.taxTotal)} ·{' '}
            <strong className="text-slate-900 dark:text-slate-100">Total {money(totals.total)}</strong>
          </span>
          {isDraft ? (
            <Button disabled={busy || !partyId || Number(totals.total) <= 0} onClick={() => act('submit')}>
              Submit for approval
            </Button>
          ) : null}
          {doc.status === 'approved' ? (
            <Button disabled={busy} onClick={() => act('post')}>
              Post
            </Button>
          ) : null}
          {doc.entry_id ? (
            <Button variant="outline" asChild>
              <Link href={`/journal/${doc.entry_id}`}>View journal entry</Link>
            </Button>
          ) : null}
        </div>
      }
    >
      <div className="space-y-6 p-1">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className={field}>
            <Label>Vendor</Label>
            {isDraft ? (
              <SearchSelect
                options={vendors.map((v) => ({ value: v.id, label: v.display_name ?? '' }))}
                value={partyId}
                onChange={(v) => setPartyId(v ?? '')}
                placeholder="Select vendor…"
              />
            ) : (
              <p className="text-sm">{doc.vendor_name}</p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className={field}>
              <Label>Bill date</Label>
              {isDraft ? (
                <Input type="date" value={documentDate} onChange={(e) => setDocumentDate(e.target.value)} />
              ) : (
                <p className="text-sm">{doc.document_date}</p>
              )}
            </div>
            <div className={field}>
              <Label>Due date</Label>
              {isDraft ? (
                <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
              ) : (
                <p className="text-sm">{doc.due_date ?? '—'}</p>
              )}
            </div>
          </div>
          <div className={field}>
            <Label>Vendor ref #</Label>
            {isDraft ? (
              <Input value={referenceNumber} onChange={(e) => setReferenceNumber(e.target.value)} />
            ) : (
              <p className="text-sm">{doc.reference_number ?? '—'}</p>
            )}
          </div>
          <div className={field}>
            <Label>Memo</Label>
            {isDraft ? (
              <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
            ) : (
              <p className="text-sm">{doc.memo ?? '—'}</p>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <Label>Lines</Label>
          {isDraft ? (
            <>
              {lines.map((l, i) => (
                <div key={i} className="grid items-start gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1.6fr)_110px_120px_36px]">
                  <SearchSelect
                    options={accounts.map((a) => ({ value: a.id, label: `${a.number ?? ''} ${a.name ?? ''}`.trim() }))}
                    value={l.accountId}
                    onChange={(v) => setLine(i, { accountId: v ?? '' })}
                    placeholder="Account…"
                  />
                  <Input placeholder="Description" value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} />
                  <Input
                    inputMode="decimal"
                    placeholder="0.00"
                    className="text-right tabular-nums"
                    value={l.amount}
                    onChange={(e) => setLine(i, { amount: e.target.value })}
                  />
                  <Select value={l.taxCodeId} onChange={(e) => setLine(i, { taxCodeId: e.target.value })}>
                    <option value="">No tax</option>
                    {taxCodes.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.code}
                      </option>
                    ))}
                  </Select>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Remove line"
                    disabled={lines.length === 1}
                    onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
                  >
                    <Trash2 size={15} />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setLines((ls) => [...ls, { accountId: '', description: '', amount: '', taxCodeId: '' }])}
              >
                <Plus size={14} /> Add line
              </Button>
            </>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500 uppercase dark:text-slate-400">
                  <th className="py-1.5">Account</th>
                  <th>Description</th>
                  <th className="text-right">Amount</th>
                  <th className="text-right">Tax</th>
                </tr>
              </thead>
              <tbody>
                {bill.lines.map((l: any) => {
                  const acct = accounts.find((a) => a.id === l.account_id)
                  return (
                    <tr key={l.id} className="border-t border-slate-100 dark:border-slate-800">
                      <td className="py-2">
                        <span className="mr-1.5 font-mono text-xs text-slate-500">{acct?.number}</span>
                        {acct?.name}
                      </td>
                      <td className="text-slate-500 dark:text-slate-400">{l.description}</td>
                      <td className={cn('text-right tabular-nums')}>{money(l.amount)}</td>
                      <td className="text-right tabular-nums">{money(l.tax_amount)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </UrlDrawer>
  )
}

'use client'

import { useState } from 'react'
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { ActionError, portalAction } from './portal-client'

export type BillingReviewLineView = {
  id: string
  sourceDate: string
  description: string | null
  quantity: string
  unit: string | null
  amount: string
}

export type BillingReviewLabels = {
  date: string
  description: string
  quantity: string
  amount: string
  total: string
  accept: string
  requestChanges: string
  signerName: string
  purchaseOrder: string
  comment: string
  confirm: string
  acceptSubmit: string
  accepting: string
  disputeHint: string
  lineNotePlaceholder: string
  generalComment: string
  disputeSubmit: string
  sending: string
  addNote: string
}

const inputClass =
  'mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-600 dark:bg-slate-950 dark:text-white'
const primaryButton =
  'rounded-xl bg-teal-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-teal-800 disabled:opacity-50'

/**
 * The customer's decision on a billing package. Accepting names the signer
 * and may supply a purchase order number; requesting changes attaches a note
 * to each line that needs attention. Both carry the digest the page was
 * rendered from, so a decision never applies to content that changed since.
 */
export function BillingReviewDecision({
  sessionToken,
  prebillId,
  digest,
  total,
  lines,
  labels,
}: {
  sessionToken: string
  prebillId: string
  digest: string
  total: string
  lines: BillingReviewLineView[]
  labels: BillingReviewLabels
}) {
  const [mode, setMode] = useState<'accept' | 'dispute'>('accept')
  const [signerName, setSignerName] = useState('')
  const [purchaseOrderNumber, setPurchaseOrderNumber] = useState('')
  const [note, setNote] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [lineNotes, setLineNotes] = useState<Record<string, string>>({})
  const [openNotes, setOpenNotes] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const disputed = Object.entries(lineNotes).filter(([, value]) => value.trim().length > 0)

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      if (mode === 'accept') {
        await portalAction('/api/portal/actions', {
          sessionToken, action: 'acceptBillingReview', prebillId, digest,
          signerName, purchaseOrderNumber: purchaseOrderNumber || null, note: note || null,
        })
      } else {
        await portalAction('/api/portal/actions', {
          sessionToken, action: 'disputeBillingReview', prebillId, digest,
          note: note || null,
          lines: disputed.map(([lineId, value]) => ({ lineId, note: value })),
        })
      }
      window.location.reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  const canSubmit = mode === 'accept'
    ? signerName.trim().length > 0 && confirmed
    : disputed.length > 0 || note.trim().length > 0

  return (
    <div className="mt-4 space-y-4">
      <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-700">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="px-3 py-2">{labels.date}</TableHead>
              <TableHead className="px-3 py-2">{labels.description}</TableHead>
              <TableHead className="px-3 py-2 text-right">{labels.quantity}</TableHead>
              <TableHead className="px-3 py-2 text-right">{labels.amount}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((line) => {
              const noteOpen = mode === 'dispute' && (openNotes[line.id] || Boolean(lineNotes[line.id]))
              const flagged = mode === 'dispute' && Boolean(lineNotes[line.id]?.trim())
              return (
                <TableRow key={line.id} className={`border-t border-slate-100 align-top dark:border-slate-800 ${flagged ? 'bg-amber-50 dark:bg-amber-950/20' : ''}`}>
                  <TableCell className="whitespace-nowrap px-3 py-2 text-slate-500">{line.sourceDate}</TableCell>
                  <TableCell className="px-3 py-2 text-slate-900 dark:text-white">
                    {line.description ?? '—'}
                    {mode === 'dispute' && !noteOpen ? (
                      <button
                        type="button"
                        onClick={() => setOpenNotes((current) => ({ ...current, [line.id]: true }))}
                        className="ml-2 text-xs font-medium text-teal-700 hover:underline dark:text-teal-300"
                      >
                        {labels.addNote}
                      </button>
                    ) : null}
                    {noteOpen ? (
                      <textarea
                        aria-label={labels.lineNotePlaceholder}
                        placeholder={labels.lineNotePlaceholder}
                        maxLength={1000}
                        rows={2}
                        value={lineNotes[line.id] ?? ''}
                        onChange={(event) => setLineNotes((current) => ({ ...current, [line.id]: event.target.value }))}
                        className={inputClass}
                      />
                    ) : null}
                  </TableCell>
                  <TableCell className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-slate-500">
                    {line.quantity.replace(/\.?0+$/, '')}{line.unit ? ` ${line.unit}` : ''}
                  </TableCell>
                  <TableCell className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{line.amount}</TableCell>
                </TableRow>
              )
            })}
          </TableBody>
          <TableFooter>
            <TableRow className="border-t border-slate-200 font-semibold dark:border-slate-700">
              <TableCell className="px-3 py-2" colSpan={3}>{labels.total}</TableCell>
              <TableCell className="px-3 py-2 text-right tabular-nums">{total}</TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </div>

      <div role="tablist" className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-1 text-sm font-medium dark:border-slate-700 dark:bg-slate-800">
        {(['accept', 'dispute'] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={mode === value}
            onClick={() => { setMode(value); setError(null) }}
            className={`rounded-md px-3 py-1.5 ${mode === value
              ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-900 dark:text-white'
              : 'text-slate-600 hover:text-slate-900 dark:text-slate-300'}`}
          >
            {value === 'accept' ? labels.accept : labels.requestChanges}
          </button>
        ))}
      </div>

      {mode === 'accept' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm text-slate-700 dark:text-slate-200">
            {labels.signerName}
            <input value={signerName} maxLength={200} onChange={(event) => setSignerName(event.target.value)} className={inputClass} autoComplete="name" />
          </label>
          <label className="block text-sm text-slate-700 dark:text-slate-200">
            {labels.purchaseOrder}
            <input value={purchaseOrderNumber} maxLength={100} onChange={(event) => setPurchaseOrderNumber(event.target.value)} className={inputClass} />
          </label>
        </div>
      ) : (
        <p className="text-sm text-slate-600 dark:text-slate-300">{labels.disputeHint}</p>
      )}

      <label className="block text-sm text-slate-700 dark:text-slate-200">
        {mode === 'accept' ? labels.comment : labels.generalComment}
        <textarea value={note} maxLength={2000} rows={3} onChange={(event) => setNote(event.target.value)} className={inputClass} />
      </label>

      {mode === 'accept' ? (
        <label className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-200">
          <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} className="mt-0.5" />
          <span>{labels.confirm}</span>
        </label>
      ) : null}

      <div className="flex justify-end">
        <button type="button" onClick={submit} disabled={!canSubmit || busy} className={primaryButton}>
          {busy
            ? (mode === 'accept' ? labels.accepting : labels.sending)
            : (mode === 'accept' ? labels.acceptSubmit : labels.disputeSubmit)}
        </button>
      </div>
      <ActionError message={error} />
    </div>
  )
}

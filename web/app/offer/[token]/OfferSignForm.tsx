'use client'

import { useState } from 'react'

/**
 * Offer signing form (HR-18): typed-name e-sign plus decline-with-reason.
 * Posts to the sessionless offer API; the IP is hashed server-side, never
 * stored. A signed offer stays signed — resubmission surfaces the recorded
 * state instead of a second signature.
 */
export function OfferSignForm({
  token,
  candidateName,
  documentHash,
}: {
  token: string
  candidateName: string
  /** Hash of the displayed terms — returned with the signature to prove what was shown. */
  documentHash: string
}) {
  const [signerName, setSignerName] = useState(candidateName === 'candidate' ? '' : candidateName)
  const [reason, setReason] = useState('')
  const [mode, setMode] = useState<'sign' | 'decline'>('sign')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const body =
        mode === 'sign'
          ? { action: 'sign', signerName, documentHash }
          : { action: 'decline', reason }
      const res = await fetch(`/api/recruiting/offer/${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      // Error bodies are checked before they are parsed: a refusal names
      // the remedy instead of becoming a parse error.
      if (!res.ok) {
        const parsed = (await res.json().catch(() => null)) as { error?: string } | null
        setError(parsed?.error ?? 'This signing link is no longer live.')
        return
      }
      setDone(mode === 'sign' ? 'signed' : 'declined')
    } catch {
      setError('Something went wrong. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  if (done === 'signed') {
    return (
      <p role="status" className="rounded-md bg-green-50 p-4 text-sm text-green-800">
        Signed. Thank you — the hiring team has your response.
      </p>
    )
  }
  if (done === 'declined') {
    return (
      <p role="status" className="rounded-md bg-slate-100 p-4 text-sm text-slate-700">
        Declined. The hiring team has your response.
      </p>
    )
  }

  return (
    <div>
      <div className="mb-4 flex gap-2" role="group" aria-label="Respond">
        <button
          type="button"
          onClick={() => setMode('sign')}
          aria-pressed={mode === 'sign'}
          className={`rounded-md px-4 py-2 text-sm font-medium ${mode === 'sign' ? 'bg-slate-900 text-white' : 'border'}`}
        >
          Sign
        </button>
        <button
          type="button"
          onClick={() => setMode('decline')}
          aria-pressed={mode === 'decline'}
          className={`rounded-md px-4 py-2 text-sm font-medium ${mode === 'decline' ? 'bg-slate-900 text-white' : 'border'}`}
        >
          Decline
        </button>
      </div>
      {mode === 'sign' ? (
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Type your full name to sign</span>
          <input
            type="text"
            value={signerName}
            onChange={(e) => setSignerName(e.target.value)}
            autoComplete="name"
            className="w-full rounded-md border px-3 py-2 text-sm"
          />
        </label>
      ) : (
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Reason for declining</span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            className="w-full rounded-md border px-3 py-2 text-sm"
          />
        </label>
      )}
      {error && (
        <p role="alert" className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-800">
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={submit}
        disabled={busy || (mode === 'sign' ? signerName.trim().length === 0 : reason.trim().length === 0)}
        className="mt-4 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {busy ? 'Sending…' : mode === 'sign' ? 'Sign offer' : 'Decline offer'}
      </button>
    </div>
  )
}

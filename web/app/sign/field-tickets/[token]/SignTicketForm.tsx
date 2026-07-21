'use client'

import { useState } from 'react'
import { SignaturePad } from '../../../../components/signature-pad'

/** The signature capture half of the public signing page. Deliberately does
 * not use the app's i18n provider (public route, no session): plain English
 * strings, matching the emailed link's language. */
export function SignTicketForm(props: { token: string; alreadySigned: boolean; signedBy: string | null }) {
  const [signature, setSignature] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [comment, setComment] = useState('')
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>(props.alreadySigned ? 'done' : 'idle')
  const [error, setError] = useState('')

  async function submit() {
    if (!signature || !name.trim()) return
    setState('busy')
    try {
      const res = await fetch('/api/sign/field-tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: props.token, signature, name: name.trim(), comment: comment.trim() || null }),
      })
      if (!res.ok) throw new Error((await res.json()).error ?? 'Signing failed')
      setState('done')
    } catch (e) {
      setError((e as Error).message)
      setState('error')
    }
  }

  if (state === 'done') {
    return (
      <div className="rounded-lg border border-teal-200 bg-teal-50 p-4 text-center dark:border-teal-800 dark:bg-teal-950/40">
        <p className="text-sm font-medium text-teal-800 dark:text-teal-200">
          {props.alreadySigned && props.signedBy ? `Already signed by ${props.signedBy}.` : 'Thank you — the timesheet is signed.'}
        </p>
        <p className="mt-1 text-xs text-teal-700/80 dark:text-teal-300/80">A confirmation copy will accompany the invoice.</p>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-700">
      <p className="mb-2 text-sm font-medium text-slate-900 dark:text-slate-100">Sign to approve this timesheet</p>
      <SignaturePad onChange={setSignature} clearLabel="Clear" />
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <input
          aria-label="Your name"
          placeholder="Your name"
          className="h-9 rounded-md border border-slate-300 px-2 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          aria-label="Comment (optional)"
          placeholder="Comment (optional)"
          className="h-9 rounded-md border border-slate-300 px-2 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
      </div>
      {state === 'error' && <p className="mt-2 text-sm text-rose-600">{error}</p>}
      <button
        type="button"
        onClick={submit}
        disabled={state === 'busy' || !signature || !name.trim()}
        className="mt-3 w-full rounded-md bg-teal-600 py-2 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-50"
      >
        {state === 'busy' ? 'Signing…' : 'Sign timesheet'}
      </button>
    </div>
  )
}

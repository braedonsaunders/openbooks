'use client'

import { useState } from 'react'

/**
 * The signature capture half of the public signing page. Deliberately
 * does not use the app's i18n provider (public route, no session):
 * plain English strings. The typed name is the signature — the service
 * records it with the timestamp and the document hash as the HMAC
 * evidence record.
 */
export function SignDocumentForm(props: {
  token: string
  signerStatus: string
  acknowledgmentOnly: boolean
}) {
  const [name, setName] = useState('')
  const [reason, setReason] = useState('')
  const [declining, setDeclining] = useState(false)
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>(
    props.signerStatus === 'signed' ? 'done' : 'idle',
  )
  const [doneAction, setDoneAction] = useState<'signed' | 'declined' | 'acknowledged'>('signed')
  const [error, setError] = useState('')

  async function call(action: { action: string; name?: string; reason?: string }) {
    setState('busy')
    setError('')
    const res = await fetch(`/api/documents/sign/${props.token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(action),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      setError(body?.error ?? 'This action failed — the message above explains why.')
      setState('error')
      return
    }
    setDoneAction(action.action as 'signed' | 'declined' | 'acknowledged')
    setState('done')
  }

  if (state === 'done') {
    return (
      <div className="rounded-lg border border-teal-200 bg-teal-50 p-4 text-center dark:border-teal-800 dark:bg-teal-950/40">
        <p className="text-sm font-medium text-teal-800 dark:text-teal-200">
          {doneAction === 'signed' && 'Thank you — your signature is recorded.'}
          {doneAction === 'acknowledged' && 'Thank you — your acknowledgment is recorded.'}
          {doneAction === 'declined' && 'Your decline is recorded — HR will follow up.'}
        </p>
      </div>
    )
  }

  if (props.signerStatus === 'declined') {
    return (
      <div className="rounded-lg border border-slate-200 p-4 text-center dark:border-slate-700">
        <p className="text-sm text-slate-600 dark:text-slate-300">This link recorded a decline — ask HR to re-issue the document.</p>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-700">
      {props.acknowledgmentOnly ? (
        <>
          <p className="mb-2 text-sm font-medium text-slate-900 dark:text-slate-100">
            Confirm you have read and understood this document
          </p>
          <button
            type="button"
            onClick={() => call({ action: 'acknowledge' })}
            disabled={state === 'busy'}
            className="w-full rounded-md bg-teal-600 py-2 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-50"
          >
            {state === 'busy' ? 'Recording…' : 'Acknowledge'}
          </button>
        </>
      ) : declining ? (
        <>
          <label className="mb-2 block text-sm font-medium text-slate-900 dark:text-slate-100" htmlFor="decline-reason">
            Why are you declining? HR reads this to re-issue correctly.
          </label>
          <textarea
            id="decline-reason"
            rows={3}
            className="w-full rounded-md border border-slate-300 px-2 py-1 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => call({ action: 'decline', reason: reason.trim() })}
              disabled={state === 'busy' || !reason.trim()}
              className="flex-1 rounded-md bg-rose-600 py-2 text-sm font-medium text-white hover:bg-rose-700 disabled:opacity-50"
            >
              {state === 'busy' ? 'Recording…' : 'Decline'}
            </button>
            <button
              type="button"
              onClick={() => setDeclining(false)}
              className="flex-1 rounded-md border border-slate-300 py-2 text-sm dark:border-slate-600"
            >
              Back
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="mb-2 text-sm font-medium text-slate-900 dark:text-slate-100">Type your name to sign</p>
          <input
            aria-label="Your name"
            placeholder="Your name"
            className="h-9 w-full rounded-md border border-slate-300 px-2 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button
            type="button"
            onClick={() => call({ action: 'sign', name: name.trim() })}
            disabled={state === 'busy' || !name.trim()}
            className="mt-3 w-full rounded-md bg-teal-600 py-2 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-50"
          >
            {state === 'busy' ? 'Signing…' : 'Sign document'}
          </button>
          <button
            type="button"
            onClick={() => setDeclining(true)}
            className="mt-2 w-full rounded-md py-2 text-sm text-slate-600 underline dark:text-slate-300"
          >
            Decline instead
          </button>
        </>
      )}
      {state === 'error' && <p className="mt-2 text-sm text-rose-600">{error}</p>}
    </div>
  )
}

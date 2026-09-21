'use client'

import { useState } from 'react'

/**
 * Public application form (HR-18): name + contact, future-roles opt-in,
 * and the honeypot field humans never fill. Posts to the sessionless apply
 * API; refusals surface the server's message. One candidacy per opening is
 * enforced server-side.
 */
export function CareersApplyForm({ postingId }: { postingId: string }) {
  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [futureRoles, setFutureRoles] = useState(false)
  const [website, setWebsite] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)

  async function apply() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/recruiting/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          postingId,
          displayName,
          email: email || null,
          phone: phone || null,
          consentFutureRoles: futureRoles,
          website: website || undefined,
        }),
      })
      // Error bodies are checked before they are parsed.
      if (!res.ok) {
        const parsed = (await res.json().catch(() => null)) as { error?: string } | null
        setError(parsed?.error ?? 'Your application was not received. Please try again.')
        return
      }
      setDone(true)
    } catch {
      setError('Your application was not received. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <p role="status" className="rounded-md bg-green-50 p-4 text-sm text-green-800">
        Received. Thank you — the hiring team will review your application.
      </p>
    )
  }

  return (
    <div className="mt-4 border-t pt-4">
      <h3 className="text-sm font-medium">Apply for this role</h3>
      <div className="mt-3 space-y-3">
        <label className="block text-sm">
          <span className="mb-1 block">Full name</span>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            autoComplete="name"
            className="w-full rounded-md border px-3 py-2 text-sm"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block">Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            className="w-full rounded-md border px-3 py-2 text-sm"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block">Phone (optional)</span>
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            autoComplete="tel"
            className="w-full rounded-md border px-3 py-2 text-sm"
          />
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={futureRoles}
            onChange={(e) => setFutureRoles(e.target.checked)}
            className="mt-1 h-4 w-4"
          />
          <span>Keep my application on file for future roles.</span>
        </label>
        {/* Honeypot: hidden from humans and assistive tech, irresistible to bots. */}
        <input
          type="text"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
          tabIndex={-1}
          autoComplete="off"
          aria-hidden="true"
          className="hidden"
        />
      </div>
      {error && (
        <p role="alert" className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-800">
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={apply}
        disabled={busy || displayName.trim().length === 0}
        className="mt-4 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {busy ? 'Sending…' : 'Submit application'}
      </button>
    </div>
  )
}

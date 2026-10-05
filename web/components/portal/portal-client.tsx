'use client'

import { useState, type FormEvent, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'

/** POST a portal action. res.ok is checked before any body is parsed. */
export async function portalAction<T>(path: string, payload: Record<string, unknown>): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    let detail = ''
    try {
      const data = (await res.json()) as { error?: string; remedy?: string }
      detail = [data.error, data.remedy].filter(Boolean).join(' — ')
    } catch {
      detail = ''
    }
    throw new Error(detail || `Request failed (${res.status})`)
  }
  return (await res.json()) as T
}

export function ActionError({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <p className="mt-2 text-center text-sm text-red-600 dark:text-red-400" role="alert">
      {message}
    </p>
  )
}

function useBusy() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return { busy, setBusy, error, setError }
}

const buttonClass =
  'rounded-xl bg-teal-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-teal-800 disabled:opacity-50'

export function PortalActionButton({
  sessionToken,
  payload,
  children,
  onDone,
}: {
  sessionToken: string
  payload: Record<string, unknown>
  children: ReactNode
  onDone?: () => void
}) {
  const { busy, setBusy, error, setError } = useBusy()
  async function run() {
    setBusy(true)
    setError(null)
    try {
      await portalAction('/api/portal/actions', { sessionToken, ...payload })
      onDone?.()
      window.location.reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }
  return (
    <span>
      <button type="button" onClick={run} disabled={busy} className={buttonClass}>
        {children}
      </button>
      <ActionError message={error} />
    </span>
  )
}

export function SignInForm({ requestLabel, emailLabel, sentText }: { requestLabel: string; emailLabel: string; sentText: string }) {
  const { busy, setBusy, error, setError } = useBusy()
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await portalAction('/api/portal/request', { email })
      setSent(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  if (sent) return <p className="text-center text-sm text-slate-700 dark:text-slate-200">{sentText}</p>
  return (
    <form onSubmit={submit} className="space-y-4">
      <label className="block">
        <span className="text-sm font-medium text-slate-700 dark:text-slate-200">{emailLabel}</span>
        <input
          type="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-slate-900 dark:border-slate-600 dark:bg-slate-800 dark:text-white"
          autoComplete="email"
        />
      </label>
      <button type="submit" disabled={busy} className="h-11 w-full rounded-xl bg-teal-700 text-base font-semibold text-white transition hover:bg-teal-800 disabled:opacity-50">
        {requestLabel}
      </button>
      <ActionError message={error} />
    </form>
  )
}

export function PayInvoiceButton({ sessionToken, documentId, providers, label }: { sessionToken: string; documentId: string; providers: string[]; label: string }) {
  const { busy, setBusy, error, setError } = useBusy()
  const router = useRouter()
  const [provider, setProvider] = useState(providers[0] ?? 'stripe')
  async function pay() {
    setBusy(true)
    setError(null)
    try {
      const result = await portalAction<{ paymentToken: string }>('/api/portal/actions', {
        sessionToken, action: 'payInvoice', documentId, provider,
      })
      router.push(`/pay/${result.paymentToken}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }
  if (providers.length === 0) return null
  return (
    <span className="flex items-center gap-2">
      {providers.length > 1 ? (
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          aria-label="provider"
          className="rounded-xl border border-slate-300 px-2 py-2 text-sm dark:border-slate-600 dark:bg-slate-800"
        >
          {providers.map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
      ) : null}
      <button type="button" onClick={pay} disabled={busy} className={buttonClass}>
        {label}
      </button>
      <ActionError message={error} />
    </span>
  )
}

export function MethodSetupButton({ sessionToken, providers, label }: { sessionToken: string; providers: string[]; label: string }) {
  const { busy, setBusy, error, setError } = useBusy()
  const router = useRouter()
  const [provider, setProvider] = useState(providers[0] ?? 'stripe')
  async function start() {
    setBusy(true)
    setError(null)
    try {
      const result = await portalAction<{ setupUrl: string }>('/api/portal/actions', {
        sessionToken, action: 'startMethodSetup', provider,
      })
      router.push(result.setupUrl)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }
  if (providers.length === 0) return null
  return (
    <span className="flex items-center gap-2">
      {providers.length > 1 ? (
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          aria-label="provider"
          className="rounded-xl border border-slate-300 px-2 py-2 text-sm dark:border-slate-600 dark:bg-slate-800"
        >
          {providers.map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
      ) : null}
      <button type="button" onClick={start} disabled={busy} className={buttonClass}>
        {label}
      </button>
      <ActionError message={error} />
    </span>
  )
}

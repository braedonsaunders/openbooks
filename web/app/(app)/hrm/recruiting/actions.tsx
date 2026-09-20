'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Input, Label, Select, Textarea } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../../lib/api-error'

/**
 * Recruiting action islands: small client forms posting through the same
 * /api/hrm/recruiting/* routes the API clients use. Every refusal renders
 * as the error (res.ok is checked before parsing), every success refreshes
 * the loader-resolved drawer. Labels arrive loader-resolved — no org id,
 * user id, or Authz crosses into the client.
 */

export interface Option {
  value: string
  label: string
}

function useRefresh(): () => void {
  const router = useRouter()
  return () => router.refresh()
}

async function postJson(url: string, method: string, body: unknown): Promise<Response> {
  return fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

/** Attach a candidate to the requisition: create the prospect, then the candidacy. */
export function ApplicationAttachIsland({
  requisitionId,
  labels,
}: {
  requisitionId: string
  labels: { name: string; email: string; phone: string; submit: string; failed: string }
}) {
  const refresh = useRefresh()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const created = await postJson('/api/hrm/recruiting/candidates', 'POST', {
        displayName: name.trim(),
        email: email.trim() || null,
        phone: phone.trim() || null,
      })
      if (!created.ok) {
        setError(await readApiErrorMessage(created, labels.failed))
        setBusy(false)
        return
      }
      const payload = (await created.json().catch(() => ({}))) as {
        candidate?: { id?: unknown }
        mergedInto?: { id?: unknown } | null
      }
      const survivor =
        typeof payload.mergedInto?.id === 'string'
          ? payload.mergedInto.id
          : typeof payload.candidate?.id === 'string'
            ? payload.candidate.id
            : null
      if (survivor === null) {
        setError(labels.failed)
        setBusy(false)
        return
      }
      const attached = await postJson('/api/hrm/recruiting/applications', 'POST', {
        requisitionId,
        candidateId: survivor,
        merged: payload.mergedInto !== null && payload.mergedInto !== undefined,
      })
      if (!attached.ok) {
        setError(await readApiErrorMessage(attached, labels.failed))
        setBusy(false)
        return
      }
      setName('')
      setEmail('')
      setPhone('')
      setBusy(false)
      refresh()
    } catch {
      setError(labels.failed)
      setBusy(false)
    }
  }

  return (
    <form className="space-y-2" onSubmit={submit}>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label htmlFor={`attach-name-${requisitionId}`}>{labels.name}</Label>
          <Input id={`attach-name-${requisitionId}`} value={name} onChange={(event) => setName(event.target.value)} required />
        </div>
        <div>
          <Label htmlFor={`attach-email-${requisitionId}`}>{labels.email}</Label>
          <Input id={`attach-email-${requisitionId}`} value={email} onChange={(event) => setEmail(event.target.value)} />
        </div>
      </div>
      <div>
        <Label htmlFor={`attach-phone-${requisitionId}`}>{labels.phone}</Label>
        <Input id={`attach-phone-${requisitionId}`} value={phone} onChange={(event) => setPhone(event.target.value)} />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={busy} size="sm">
        {labels.submit}
      </Button>
    </form>
  )
}

/** Move, reject, or withdraw one application. */
export function ApplicationActionsIsland({
  applicationId,
  stages,
  labels,
}: {
  applicationId: string
  stages: Option[]
  labels: { move: string; reject: string; reason: string; withdraw: string; failed: string }
}) {
  const refresh = useRefresh()
  const [stage, setStage] = useState(stages[0]?.value ?? '')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function act(body: unknown): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const res = await postJson(`/api/hrm/recruiting/applications/${applicationId}`, 'PATCH', body)
      if (!res.ok) {
        setError(await readApiErrorMessage(res, labels.failed))
        setBusy(false)
        return
      }
      setBusy(false)
      refresh()
    } catch {
      setError(labels.failed)
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Select aria-label={labels.move} value={stage} onChange={(event) => setStage(event.target.value)}>
          {stages.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
        <Button size="sm" disabled={busy || stage === ''} onClick={() => void act({ action: 'move', toStageId: stage })}>
          {labels.move}
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <Input
          aria-label={labels.reason}
          placeholder={labels.reason}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void act({ action: 'reject', reason: reason.trim() })}>
          {labels.reject}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act({ action: 'withdraw' })}>
          {labels.withdraw}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  )
}

/** Schedule a sitting on the application with an optional employee panel. */
export function InterviewScheduleIsland({
  applicationId,
  kinds,
  employees,
  labels,
}: {
  applicationId: string
  kinds: Option[]
  employees: Option[]
  labels: { kind: string; when: string; duration: string; location: string; panel: string; submit: string; failed: string }
}) {
  const refresh = useRefresh()
  const [kind, setKind] = useState(kinds[0]?.value ?? 'video')
  const [when, setWhen] = useState('')
  const [duration, setDuration] = useState('30')
  const [location, setLocation] = useState('')
  const [panel, setPanel] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function togglePanel(id: string): void {
    setPanel((current) => (current.includes(id) ? current.filter((member) => member !== id) : [...current, id]))
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await postJson('/api/hrm/recruiting/interviews', 'POST', {
        applicationId,
        kind,
        scheduledAt: when,
        durationMinutes: duration === '' ? null : Number.parseInt(duration, 10),
        location: location.trim() || null,
        panelPartyIds: panel,
      })
      if (!res.ok) {
        setError(await readApiErrorMessage(res, labels.failed))
        setBusy(false)
        return
      }
      setWhen('')
      setLocation('')
      setPanel([])
      setBusy(false)
      refresh()
    } catch {
      setError(labels.failed)
      setBusy(false)
    }
  }

  return (
    <form className="space-y-2" onSubmit={submit}>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label>{labels.kind}</Label>
          <Select value={kind} onChange={(event) => setKind(event.target.value)}>
            {kinds.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label>{labels.when}</Label>
          <Input type="datetime-local" value={when} onChange={(event) => setWhen(event.target.value)} required />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label>{labels.duration}</Label>
          <Input inputMode="numeric" value={duration} onChange={(event) => setDuration(event.target.value)} />
        </div>
        <div>
          <Label>{labels.location}</Label>
          <Input value={location} onChange={(event) => setLocation(event.target.value)} />
        </div>
      </div>
      {employees.length > 0 ? (
        <fieldset>
          <legend className="text-xs font-medium text-slate-700 dark:text-slate-300">{labels.panel}</legend>
          <div className="mt-1 flex flex-wrap gap-2">
            {employees.map((option) => (
              <label key={option.value} className="flex items-center gap-1 text-xs text-slate-600 dark:text-slate-300">
                <input type="checkbox" checked={panel.includes(option.value)} onChange={() => togglePanel(option.value)} />
                {option.label}
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={busy} size="sm">
        {labels.submit}
      </Button>
    </form>
  )
}

/** Complete a sitting with its verdict, or cancel the schedule. */
export function InterviewActionsIsland({
  interviewId,
  outcomes,
  labels,
}: {
  interviewId: string
  outcomes: Option[]
  labels: { outcome: string; feedback: string; submit: string; cancel: string; failed: string }
}) {
  const refresh = useRefresh()
  const [outcome, setOutcome] = useState(outcomes[0]?.value ?? 'advance')
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function act(body: unknown): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const res = await postJson(`/api/hrm/recruiting/interviews/${interviewId}`, 'PATCH', body)
      if (!res.ok) {
        setError(await readApiErrorMessage(res, labels.failed))
        setBusy(false)
        return
      }
      setBusy(false)
      refresh()
    } catch {
      setError(labels.failed)
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Select aria-label={labels.outcome} value={outcome} onChange={(event) => setOutcome(event.target.value)}>
          {outcomes.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
        <Button size="sm" disabled={busy} onClick={() => void act({ action: 'complete', outcome, feedback: feedback.trim() || null })}>
          {labels.submit}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act({ action: 'cancel' })}>
          {labels.cancel}
        </Button>
      </div>
      <Textarea aria-label={labels.feedback} placeholder={labels.feedback} value={feedback} onChange={(event) => setFeedback(event.target.value)} rows={2} />
      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  )
}

/** Draft the terms on the application. */
export function OfferCreateIsland({
  applicationId,
  bases,
  labels,
}: {
  applicationId: string
  bases: Option[]
  labels: { job: string; start: string; amount: string; currency: string; basis: string; expires: string; submit: string; failed: string }
}) {
  const refresh = useRefresh()
  const [job, setJob] = useState('')
  const [start, setStart] = useState('')
  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState('USD')
  const [basis, setBasis] = useState(bases[0]?.value ?? 'annual')
  const [expires, setExpires] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await postJson('/api/hrm/recruiting/offers', 'POST', {
        applicationId,
        jobTitle: job.trim(),
        proposedStartOn: start,
        compensationAmount: amount.trim(),
        compensationCurrency: currency.trim().toUpperCase(),
        compensationBasis: basis,
        expiresOn: expires || null,
      })
      if (!res.ok) {
        setError(await readApiErrorMessage(res, labels.failed))
        setBusy(false)
        return
      }
      setBusy(false)
      refresh()
    } catch {
      setError(labels.failed)
      setBusy(false)
    }
  }

  return (
    <form className="space-y-2" onSubmit={submit}>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label>{labels.job}</Label>
          <Input value={job} onChange={(event) => setJob(event.target.value)} required />
        </div>
        <div>
          <Label>{labels.start}</Label>
          <Input type="date" value={start} onChange={(event) => setStart(event.target.value)} required />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div>
          <Label>{labels.amount}</Label>
          <Input value={amount} onChange={(event) => setAmount(event.target.value)} required />
        </div>
        <div>
          <Label>{labels.currency}</Label>
          <Input value={currency} onChange={(event) => setCurrency(event.target.value)} required />
        </div>
        <div>
          <Label>{labels.basis}</Label>
          <Select value={basis} onChange={(event) => setBasis(event.target.value)}>
            {bases.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <div>
        <Label>{labels.expires}</Label>
        <Input type="date" value={expires} onChange={(event) => setExpires(event.target.value)} />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={busy} size="sm">
        {labels.submit}
      </Button>
    </form>
  )
}

/** Send, accept (hire), decline, or withdraw one offer. */
export function OfferActionsIsland({
  offerId,
  labels,
}: {
  offerId: string
  labels: { send: string; accept: string; decline: string; withdraw: string; reason: string; failed: string }
}) {
  const refresh = useRefresh()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function act(body: unknown): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const res = await postJson(`/api/hrm/recruiting/offers/${offerId}`, 'PATCH', body)
      if (!res.ok) {
        setError(await readApiErrorMessage(res, labels.failed))
        setBusy(false)
        return
      }
      setBusy(false)
      refresh()
    } catch {
      setError(labels.failed)
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy} onClick={() => void act({ action: 'send' })}>
          {labels.send}
        </Button>
        <Button size="sm" disabled={busy} onClick={() => void act({ action: 'accept' })}>
          {labels.accept}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void act({ action: 'decline', reason: reason.trim() })}>
          {labels.decline}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act({ action: 'withdraw', reason: reason.trim() })}>
          {labels.withdraw}
        </Button>
      </div>
      <Input aria-label={labels.reason} placeholder={labels.reason} value={reason} onChange={(event) => setReason(event.target.value)} />
      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  )
}

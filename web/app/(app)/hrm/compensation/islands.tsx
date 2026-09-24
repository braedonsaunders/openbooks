'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { fetchAction } from '@braedonsaunders/appkit-errors'
import { Button, Input, Label, Select, Textarea } from '@openbooks/ui'
import { canonicalDecimal } from '../../../../lib/exact-decimal'
import { useAppAction } from '@/lib/use-app-action'

/**
 * Compensation client islands — one drawer/dialog per mutation, each
 * posting through the same /api/hrm/* routes the API clients use. Every
 * mutation runs on the shared action path (useAppAction + fetchAction):
 * the refusal toasts through the hook and renders inline, busy always
 * releases, and a refusal never becomes a parse error. Every string
 * arrives loader-resolved; closing navigates the URL param away.
 */

export interface CompLabels {
  failed: string
  submit: string
  cancel: string
}

function useClose(closeHref: string) {
  const router = useRouter()
  return () => router.push(closeHref)
}

export function CycleCreateForm({
  labels,
  closeHref,
  kinds,
  kindLabel,
  nameLabel,
  effectiveLabel,
  currencyLabel,
}: {
  labels: CompLabels
  closeHref: string
  kinds: { value: string; label: string }[]
  kindLabel: string
  nameLabel: string
  effectiveLabel: string
  currencyLabel: string
}) {
  const router = useRouter()
  const close = useClose(closeHref)
  const [name, setName] = useState('')
  const [kind, setKind] = useState(kinds[0]?.value ?? 'merit')
  const [effectiveOn, setEffectiveOn] = useState('')
  const [currency, setCurrency] = useState('CAD')
  const [error, setError] = useState<string | null>(null)
  // Shared action path: the refusal pins and toasts through the hook, and
  // busy always releases — a dead network can never wedge the button.
  const { busy, execute } = useAppAction()

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    await execute(
      () =>
        fetchAction<{ cycle?: { id?: unknown } }>('/api/hrm/comp-cycles', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: name.trim(),
            kind,
            effectiveOn: effectiveOn || null,
            currency: currency.trim().toUpperCase(),
            guidelineKind: 'matrix',
            guideline: { rows: [], cols: ['q1', 'q2', 'q3', 'q4'], cells: {}, unratedRow: null },
          }),
        }),
      {
        fallbackMessage: labels.failed,
        onOk: (data) => {
          const id = data.cycle?.id
          router.push(typeof id === 'string' ? `/hrm/compensation/cycles/${id}` : '/hrm/compensation')
          router.refresh()
        },
        onRefused: (actionError) => setError(actionError.displayMessage(labels.failed)),
      },
    )
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div>
        <Label htmlFor="comp-cycle-name">{nameLabel}</Label>
        <Input id="comp-cycle-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={160} />
      </div>
      <div>
        <Label htmlFor="comp-cycle-kind">{kindLabel}</Label>
        <Select id="comp-cycle-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
          {kinds.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label htmlFor="comp-cycle-effective">{effectiveLabel}</Label>
        <Input id="comp-cycle-effective" type="date" value={effectiveOn} onChange={(e) => setEffectiveOn(e.target.value)} required />
      </div>
      <div>
        <Label htmlFor="comp-cycle-currency">{currencyLabel}</Label>
        <Input id="comp-cycle-currency" value={currency} onChange={(e) => setCurrency(e.target.value)} required maxLength={3} />
      </div>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          {labels.submit}
        </Button>
        <Button type="button" variant="outline" onClick={close}>
          {labels.cancel}
        </Button>
      </div>
    </form>
  )
}

export function LineProposeForm({
  cycleId,
  lineId,
  labels,
  pctLabel,
  rateLabel,
  reasonLabel,
  pctInvalidLabel,
  closeHref,
}: {
  cycleId: string
  lineId: string
  labels: CompLabels
  pctLabel: string
  rateLabel: string
  reasonLabel: string
  /** Named refusal when the typed percent is not an exact decimal. */
  pctInvalidLabel: string
  closeHref: string
}) {
  const router = useRouter()
  const close = useClose(closeHref)
  const [mode, setMode] = useState<'pct' | 'rate'>('pct')
  const [pct, setPct] = useState('')
  const [rate, setRate] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const { busy, execute } = useAppAction()

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    // F3-33: the percent rides the exact decimal parser — Number('abc')
    // is NaN, which JSON serializes as null, so an unvalidated typo
    // arrives as an empty proposal. Refuse it here by name and send the
    // canonical decimal string; the route refuses the rest.
    const proposedPct =
      mode === 'pct' && pct.trim() !== ''
        ? (() => {
            const canon = canonicalDecimal(pct.trim(), 6)
            return canon === null || canon.startsWith('-') ? null : canon
          })()
        : null
    if (mode === 'pct' && pct.trim() !== '' && proposedPct === null) {
      setError(pctInvalidLabel)
      return
    }
    await execute(
      () =>
        fetchAction(`/api/hrm/comp-cycles/${cycleId}/lines/${lineId}?action=propose`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            proposedPct,
            proposedRate: mode === 'rate' && rate !== '' ? rate.trim() : null,
            reason: reason.trim() || null,
          }),
        }),
      {
        fallbackMessage: labels.failed,
        onOk: () => {
          router.push(closeHref)
          router.refresh()
        },
        onRefused: (actionError) => setError(actionError.displayMessage(labels.failed)),
      },
    )
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div>
        <Label htmlFor="comp-line-mode">{pctLabel} / {rateLabel}</Label>
        <Select id="comp-line-mode" value={mode} onChange={(e) => setMode(e.target.value as 'pct' | 'rate')}>
          <option value="pct">{pctLabel}</option>
          <option value="rate">{rateLabel}</option>
        </Select>
      </div>
      {mode === 'pct' ? (
        <div>
          <Label htmlFor="comp-line-pct">{pctLabel}</Label>
          <Input id="comp-line-pct" inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value)} required />
        </div>
      ) : (
        <div>
          <Label htmlFor="comp-line-rate">{rateLabel}</Label>
          <Input id="comp-line-rate" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} required />
        </div>
      )}
      <div>
        <Label htmlFor="comp-line-reason">{reasonLabel}</Label>
        <Textarea id="comp-line-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
      </div>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          {labels.submit}
        </Button>
        <Button type="button" variant="outline" onClick={close}>
          {labels.cancel}
        </Button>
      </div>
    </form>
  )
}

export function LineDecideButtons({
  cycleId,
  lineId,
  labels,
  reasonLabel,
  approveLabel,
  rejectLabel,
  reopenLabel,
}: {
  cycleId: string
  lineId: string
  labels: CompLabels
  reasonLabel: string
  approveLabel: string
  rejectLabel: string
  reopenLabel: string
}) {
  const router = useRouter()
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const { busy, execute } = useAppAction()

  async function act(action: 'approve' | 'reject' | 'reopen') {
    setError(null)
    await execute(
      () =>
        fetchAction(`/api/hrm/comp-cycles/${cycleId}/lines/${lineId}?action=${action}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reason: reason.trim() || null }),
        }),
      {
        fallbackMessage: labels.failed,
        onOk: () => router.refresh(),
        onRefused: (actionError) => setError(actionError.displayMessage(labels.failed)),
      },
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <Label htmlFor="comp-line-decide-reason">{reasonLabel}</Label>
        <Textarea id="comp-line-decide-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
      </div>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={busy} onClick={() => act('approve')}>
          {approveLabel}
        </Button>
        <Button type="button" variant="outline" disabled={busy} onClick={() => act('reject')}>
          {rejectLabel}
        </Button>
        <Button type="button" variant="outline" disabled={busy} onClick={() => act('reopen')}>
          {reopenLabel}
        </Button>
      </div>
    </div>
  )
}

export function CycleMoveButtons({
  cycleId,
  labels,
  openLabel,
  submitLabel,
  pushLabel,
  closeLabel,
  cancelLabel,
  cancelReasonLabel,
  cancelReasonRequired,
}: {
  cycleId: string
  labels: CompLabels
  openLabel: string
  submitLabel: string
  pushLabel: string
  closeLabel: string
  cancelLabel: string
  cancelReasonLabel: string
  cancelReasonRequired: string
}) {
  const router = useRouter()
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const { busy, execute } = useAppAction()

  async function act(action: 'open' | 'submit' | 'push' | 'close' | 'cancel') {
    setError(null)
    // Cancelling records the operator's own words as the audit reason —
    // never a hard-coded string, and never an empty one.
    if (action === 'cancel' && reason.trim() === '') {
      setError(cancelReasonRequired)
      return
    }
    await execute(
      () =>
        fetchAction(`/api/hrm/comp-cycles/${cycleId}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action,
            reason: action === 'cancel' ? reason.trim() : undefined,
          }),
        }),
      {
        fallbackMessage: labels.failed,
        onOk: () => router.refresh(),
        onRefused: (actionError) => setError(actionError.displayMessage(labels.failed)),
      },
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <div>
        <Label htmlFor="comp-cycle-cancel-reason">{cancelReasonLabel}</Label>
        <Textarea id="comp-cycle-cancel-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
      </div>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={busy} onClick={() => act('open')}>
          {openLabel}
        </Button>
        <Button type="button" variant="outline" disabled={busy} onClick={() => act('submit')}>
          {submitLabel}
        </Button>
        <Button type="button" disabled={busy} onClick={() => act('push')}>
          {pushLabel}
        </Button>
        <Button type="button" variant="outline" disabled={busy} onClick={() => act('close')}>
          {closeLabel}
        </Button>
        <Button type="button" variant="outline" disabled={busy} onClick={() => act('cancel')}>
          {cancelLabel}
        </Button>
      </div>
    </div>
  )
}

export function PlanCreateForm({
  labels,
  closeHref,
  nameLabel,
  fromLabel,
  toLabel,
}: {
  labels: CompLabels
  closeHref: string
  nameLabel: string
  fromLabel: string
  toLabel: string
}) {
  const router = useRouter()
  const close = useClose(closeHref)
  const [name, setName] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [error, setError] = useState<string | null>(null)
  const { busy, execute } = useAppAction()

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    await execute(
      () =>
        fetchAction<{ plan?: { id?: unknown } }>('/api/hrm/headcount-plans', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: name.trim(),
            fiscalPeriodFrom: from || null,
            fiscalPeriodTo: to || null,
          }),
        }),
      {
        fallbackMessage: labels.failed,
        onOk: (data) => {
          const id = data.plan?.id
          router.push(typeof id === 'string' ? `/hrm/compensation/plans/${id}` : '/hrm/compensation')
          router.refresh()
        },
        onRefused: (actionError) => setError(actionError.displayMessage(labels.failed)),
      },
    )
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div>
        <Label htmlFor="comp-plan-name">{nameLabel}</Label>
        <Input id="comp-plan-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={160} />
      </div>
      <div>
        <Label htmlFor="comp-plan-from">{fromLabel}</Label>
        <Input id="comp-plan-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} required />
      </div>
      <div>
        <Label htmlFor="comp-plan-to">{toLabel}</Label>
        <Input id="comp-plan-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} required />
      </div>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          {labels.submit}
        </Button>
        <Button type="button" variant="outline" onClick={close}>
          {labels.cancel}
        </Button>
      </div>
    </form>
  )
}

export function PlanLineApproveButton({
  planId,
  lineId,
  lineStatus,
  labels,
  approveLabel,
}: {
  planId: string
  lineId: string
  lineStatus: string
  labels: CompLabels
  approveLabel: string
}) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const { busy, execute } = useAppAction()
  if (lineStatus !== 'proposed') return null

  async function approve() {
    setError(null)
    await execute(
      () =>
        fetchAction(`/api/hrm/headcount-plans/${planId}/lines/${lineId}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'approve' }),
        }),
      {
        fallbackMessage: labels.failed,
        onOk: () => router.refresh(),
        onRefused: (actionError) => setError(actionError.displayMessage(labels.failed)),
      },
    )
  }

  return (
    <div className="flex items-center gap-2">
      <Button type="button" disabled={busy} onClick={approve}>
        {approveLabel}
      </Button>
      {error ? <span className="text-sm text-red-600">{error}</span> : null}
    </div>
  )
}

export function EquityGenerateForm({
  labels,
  closeHref,
  asOfLabel,
  groupALabel,
  groupBLabel,
}: {
  labels: CompLabels
  closeHref: string
  asOfLabel: string
  groupALabel: string
  groupBLabel: string
}) {
  const router = useRouter()
  const close = useClose(closeHref)
  const [asOf, setAsOf] = useState('')
  const [groupA, setGroupA] = useState('')
  const [groupB, setGroupB] = useState('')
  const [error, setError] = useState<string | null>(null)
  const { busy, execute } = useAppAction()

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    await execute(
      () =>
        fetchAction('/api/hrm/pay-gap-snapshots', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            asOf: asOf || null,
            groupA: groupA.trim(),
            groupB: groupB.trim(),
          }),
        }),
      {
        fallbackMessage: labels.failed,
        onOk: () => {
          router.push('/hrm/compensation/equity')
          router.refresh()
        },
        onRefused: (actionError) => setError(actionError.displayMessage(labels.failed)),
      },
    )
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div>
        <Label htmlFor="comp-gap-asof">{asOfLabel}</Label>
        <Input id="comp-gap-asof" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} required />
      </div>
      <div>
        <Label htmlFor="comp-gap-a">{groupALabel}</Label>
        <Input id="comp-gap-a" value={groupA} onChange={(e) => setGroupA(e.target.value)} required maxLength={160} />
      </div>
      <div>
        <Label htmlFor="comp-gap-b">{groupBLabel}</Label>
        <Input id="comp-gap-b" value={groupB} onChange={(e) => setGroupB(e.target.value)} required maxLength={160} />
      </div>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          {labels.submit}
        </Button>
        <Button type="button" variant="outline" onClick={close}>
          {labels.cancel}
        </Button>
      </div>
    </form>
  )
}

export function PayInfoRequestButton({
  employmentId,
  labels,
  requestLabel,
}: {
  employmentId: string
  labels: CompLabels
  requestLabel: string
}) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const { busy, execute } = useAppAction()

  async function request() {
    setError(null)
    await execute(
      () =>
        fetchAction('/api/hrm/pay-information-requests', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ employmentId }),
        }),
      {
        fallbackMessage: labels.failed,
        onOk: () => router.refresh(),
        onRefused: (actionError) => setError(actionError.displayMessage(labels.failed)),
      },
    )
  }

  return (
    <div className="flex items-center gap-2">
      <Button type="button" disabled={busy} onClick={request}>
        {requestLabel}
      </Button>
      {error ? <span className="text-sm text-red-600">{error}</span> : null}
    </div>
  )
}

export function CompensationSettingsForm({
  labels,
  initial,
  attributeLabel,
  thresholdLabel,
  responseDaysLabel,
  roundingLabel,
  roundingOptions,
  burdenLabel,
}: {
  labels: CompLabels
  initial: { comparisonAttributeKey: string; gapThresholdPct: string; responseDays: string; fteRounding: string; burdenRate: string }
  attributeLabel: string
  thresholdLabel: string
  roundingOptions: { value: string; label: string }[]
  responseDaysLabel: string
  roundingLabel: string
  burdenLabel: string
}) {
  const router = useRouter()
  const [attributeKey, setAttributeKey] = useState(initial.comparisonAttributeKey)
  const [threshold, setThreshold] = useState(initial.gapThresholdPct)
  const [responseDays, setResponseDays] = useState(initial.responseDays)
  const [rounding, setRounding] = useState(initial.fteRounding)
  const [burden, setBurden] = useState(initial.burdenRate)
  const [error, setError] = useState<string | null>(null)
  const { busy, execute } = useAppAction()

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    await execute(
      () =>
        fetchAction('/api/hrm/compensation-settings', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            comparisonAttributeKey: attributeKey.trim() || null,
            gapThresholdPct: threshold.trim() === '' ? null : Number(threshold),
            responseDays: responseDays.trim() === '' ? null : Number.parseInt(responseDays, 10),
            fteRounding: rounding,
            burdenRate: burden.trim() || null,
          }),
        }),
      {
        fallbackMessage: labels.failed,
        onOk: () => router.refresh(),
        onRefused: (actionError) => setError(actionError.displayMessage(labels.failed)),
      },
    )
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div>
        <Label htmlFor="comp-set-attr">{attributeLabel}</Label>
        <Input id="comp-set-attr" value={attributeKey} onChange={(e) => setAttributeKey(e.target.value)} maxLength={120} />
      </div>
      <div>
        <Label htmlFor="comp-set-threshold">{thresholdLabel}</Label>
        <Input id="comp-set-threshold" inputMode="decimal" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
      </div>
      <div>
        <Label htmlFor="comp-set-days">{responseDaysLabel}</Label>
        <Input id="comp-set-days" inputMode="numeric" value={responseDays} onChange={(e) => setResponseDays(e.target.value)} />
      </div>
      <div>
        <Label htmlFor="comp-set-rounding">{roundingLabel}</Label>
        <Select id="comp-set-rounding" value={rounding} onChange={(e) => setRounding(e.target.value)}>
          {roundingOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label htmlFor="comp-set-burden">{burdenLabel}</Label>
        <Input id="comp-set-burden" inputMode="decimal" value={burden} onChange={(e) => setBurden(e.target.value)} />
      </div>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      <div>
        <Button type="submit" disabled={busy}>
          {labels.submit}
        </Button>
      </div>
    </form>
  )
}

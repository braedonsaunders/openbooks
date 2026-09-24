'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Input, Label, Select, Textarea, UrlDrawer } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../lib/api-error'

/**
 * Me workspace client islands. Every string arrives loader-resolved as
 * props — no org id, user id, or Authz crosses into the client. Every API
 * refusal renders with its message intact — res.ok is checked before
 * parsing, failures render inline, and nothing is swallowed.
 */

/** One step's complete action inside the shared checklists table: posts to
 * the existing step endpoint (the evidence rules are unchanged) and
 * refreshes the list on success. */
export function StepCompleteButton({
  stepId,
  label,
  failedLabel,
}: {
  stepId: string
  label: string
  failedLabel: string
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  if (!stepId) return null
  const complete = async (): Promise<void> => {
    setBusy(true)
    setStatus(null)
    try {
      const res = await fetch(`/api/hrm/processes/steps/${stepId}/complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (!res.ok) {
        setStatus(await readApiErrorMessage(res, failedLabel))
        return
      }
      router.refresh()
    } catch {
      setStatus(failedLabel)
    } finally {
      setBusy(false)
    }
  }
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button size="sm" variant="outline" disabled={busy} onClick={complete}>
        {label}
      </Button>
      {status ? <span className="text-xs text-red-600 dark:text-red-400">{status}</span> : null}
    </span>
  )
}

interface ProfileDialogStrings {
  title: string
  description: string
  employments: { value: string; label: string }[]
  employmentLabel: string
  phoneLabel: string
  emailLabel: string
  addressLabel: string
  line1Label: string
  line2Label: string
  cityLabel: string
  regionLabel: string
  postalCodeLabel: string
  countryLabel: string
  emergencyLabel: string
  emergencyNameLabel: string
  emergencyRelationshipLabel: string
  emergencyPhoneLabel: string
  reasonLabel: string
  reasonPlaceholder: string
  clearHint: string
  submitLabel: string
  cancelLabel: string
  submitFailed: string
}

interface LoadedProfile {
  phone: string | null
  email: string | null
  emergencyContact: { name: string | null; relationship: string | null; phone: string | null } | null
  address: {
    line1: string | null
    line2: string | null
    city: string | null
    region: string | null
    postalCode: string | null
    country: string | null
  } | null
}

/**
 * The profile edit drawer, opened from the page header through the `edit`
 * search param; closing navigates the param away. Fields prefill from the
 * profile read; submit sends only what changed (untouched fields are
 * omitted, cleared scalars send null, the address object fully replaces
 * the profile address row) and files the profile_change request for HR
 * approval.
 */
export function ProfileDialog({
  dialog,
  closeHref,
}: {
  dialog: ProfileDialogStrings | null
  closeHref: string
}) {
  const router = useRouter()
  const [loaded, setLoaded] = useState<LoadedProfile | null>(null)
  const [employmentId, setEmploymentId] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [clearPhone, setClearPhone] = useState(false)
  const [clearEmail, setClearEmail] = useState(false)
  const [line1, setLine1] = useState('')
  const [line2, setLine2] = useState('')
  const [city, setCity] = useState('')
  const [region, setRegion] = useState('')
  const [postalCode, setPostalCode] = useState('')
  const [country, setCountry] = useState('')
  const [emergencyName, setEmergencyName] = useState('')
  const [emergencyRelationship, setEmergencyRelationship] = useState('')
  const [emergencyPhone, setEmergencyPhone] = useState('')
  const [clearEmergency, setClearEmergency] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => {
    if (!dialog) return
    let live = true
    fetch('/api/hrm/me/profile', { method: 'GET' })
      .then(async (res) => {
        if (!live) return
        if (!res.ok) {
          setStatus(await readApiErrorMessage(res, dialog.submitFailed))
          return
        }
        const body = (await res.json().catch(() => null)) as { profile?: LoadedProfile } | null
        const profile = body?.profile ?? null
        if (!profile) {
          setStatus(dialog.submitFailed)
          return
        }
        setLoaded(profile)
        setPhone(profile.phone ?? '')
        setEmail(profile.email ?? '')
        setLine1(profile.address?.line1 ?? '')
        setLine2(profile.address?.line2 ?? '')
        setCity(profile.address?.city ?? '')
        setRegion(profile.address?.region ?? '')
        setPostalCode(profile.address?.postalCode ?? '')
        setCountry(profile.address?.country ?? '')
        setEmergencyName(profile.emergencyContact?.name ?? '')
        setEmergencyRelationship(profile.emergencyContact?.relationship ?? '')
        setEmergencyPhone(profile.emergencyContact?.phone ?? '')
      })
      .catch(() => {
        if (!live) return
        setStatus(dialog.submitFailed)
      })
    return () => {
      live = false
    }
  }, [dialog])

  if (!dialog) return null
  const strings = dialog

  const submit = async (): Promise<void> => {
    // One employment binds silently; several ask which record the proposal rides.
    const boundEmployment =
      employmentId || (strings.employments.length === 1 ? (strings.employments[0]?.value ?? '') : '')
    if (!boundEmployment) {
      setStatus(strings.submitFailed)
      return
    }
    setBusy(true)
    setStatus(null)
    try {
      const changes: Record<string, unknown> = { kind: 'profile_change' }
      if (clearPhone) changes.phone = null
      else if (loaded && phone.trim() !== (loaded.phone ?? '')) changes.phone = phone.trim()
      if (clearEmail) changes.email = null
      else if (loaded && email.trim() !== (loaded.email ?? '')) changes.email = email.trim()
      const addressTouched =
        line1.trim() !== (loaded?.address?.line1 ?? '') ||
        line2.trim() !== (loaded?.address?.line2 ?? '') ||
        city.trim() !== (loaded?.address?.city ?? '') ||
        region.trim() !== (loaded?.address?.region ?? '') ||
        postalCode.trim() !== (loaded?.address?.postalCode ?? '') ||
        country.trim() !== (loaded?.address?.country ?? '')
      if (addressTouched) {
        changes.address = {
          line1: line1.trim(),
          line2: line2.trim() === '' ? null : line2.trim(),
          city: city.trim() === '' ? null : city.trim(),
          region: region.trim() === '' ? null : region.trim(),
          postalCode: postalCode.trim() === '' ? null : postalCode.trim(),
          country: country.trim() === '' ? null : country.trim(),
        }
      }
      if (clearEmergency) changes.emergencyContact = null
      else {
        const name = emergencyName.trim()
        const relationship = emergencyRelationship.trim()
        const emergencyPhoneValue = emergencyPhone.trim()
        const before = loaded?.emergencyContact
        const touched =
          name !== (before?.name ?? '') ||
          relationship !== (before?.relationship ?? '') ||
          emergencyPhoneValue !== (before?.phone ?? '')
        if (touched) {
          changes.emergencyContact = {
            name: name === '' ? null : name,
            relationship: relationship === '' ? null : relationship,
            phone: emergencyPhoneValue === '' ? null : emergencyPhoneValue,
          }
        }
      }
      const res = await fetch('/api/hrm/me/profile-changes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ employmentId: boundEmployment, changes, reason: reason.trim() }),
      })
      if (!res.ok) {
        setStatus(await readApiErrorMessage(res, strings.submitFailed))
        return
      }
      router.push(closeHref)
      router.refresh()
    } catch {
      setStatus(strings.submitFailed)
    } finally {
      setBusy(false)
    }
  }

  return (
    <UrlDrawer open closeHref={closeHref} title={strings.title} description={strings.description}>
      <div className="flex flex-col gap-4 p-4">
        {strings.employments.length > 1 ? (
          <div className="flex flex-col gap-1.5">
            <Label>{strings.employmentLabel}</Label>
            <Select value={employmentId} onChange={(event) => setEmploymentId(event.target.value)}>
              <option value="">{strings.employmentLabel}</option>
              {strings.employments.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label>{strings.phoneLabel}</Label>
            <Input value={phone} disabled={clearPhone} onChange={(event) => setPhone(event.target.value)} />
            <label className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
              <input type="checkbox" checked={clearPhone} onChange={(event) => setClearPhone(event.target.checked)} />
              {strings.clearHint}
            </label>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>{strings.emailLabel}</Label>
            <Input value={email} disabled={clearEmail} onChange={(event) => setEmail(event.target.value)} />
            <label className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
              <input type="checkbox" checked={clearEmail} onChange={(event) => setClearEmail(event.target.checked)} />
              {strings.clearHint}
            </label>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>{strings.addressLabel}</Label>
          <Input aria-label={strings.line1Label} placeholder={strings.line1Label} value={line1} onChange={(event) => setLine1(event.target.value)} />
          <Input aria-label={strings.line2Label} placeholder={strings.line2Label} value={line2} onChange={(event) => setLine2(event.target.value)} />
          <div className="grid grid-cols-2 gap-3">
            <Input aria-label={strings.cityLabel} placeholder={strings.cityLabel} value={city} onChange={(event) => setCity(event.target.value)} />
            <Input aria-label={strings.regionLabel} placeholder={strings.regionLabel} value={region} onChange={(event) => setRegion(event.target.value)} />
            <Input aria-label={strings.postalCodeLabel} placeholder={strings.postalCodeLabel} value={postalCode} onChange={(event) => setPostalCode(event.target.value)} />
            <Input aria-label={strings.countryLabel} placeholder={strings.countryLabel} value={country} onChange={(event) => setCountry(event.target.value)} />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>{strings.emergencyLabel}</Label>
          <Input aria-label={strings.emergencyNameLabel} placeholder={strings.emergencyNameLabel} value={emergencyName} disabled={clearEmergency} onChange={(event) => setEmergencyName(event.target.value)} />
          <Input aria-label={strings.emergencyRelationshipLabel} placeholder={strings.emergencyRelationshipLabel} value={emergencyRelationship} disabled={clearEmergency} onChange={(event) => setEmergencyRelationship(event.target.value)} />
          <Input aria-label={strings.emergencyPhoneLabel} placeholder={strings.emergencyPhoneLabel} value={emergencyPhone} disabled={clearEmergency} onChange={(event) => setEmergencyPhone(event.target.value)} />
          <label className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
            <input type="checkbox" checked={clearEmergency} onChange={(event) => setClearEmergency(event.target.checked)} />
            {strings.clearHint}
          </label>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>{strings.reasonLabel}</Label>
          <Textarea placeholder={strings.reasonPlaceholder} value={reason} onChange={(event) => setReason(event.target.value)} />
        </div>
        {status ? <p className="text-sm text-red-600 dark:text-red-400">{status}</p> : null}
        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" disabled={busy} onClick={() => router.push(closeHref)}>
            {strings.cancelLabel}
          </Button>
          <Button disabled={busy} onClick={submit}>
            {strings.submitLabel}
          </Button>
        </div>
      </div>
    </UrlDrawer>
  )
}

/** One shared review's acknowledge action inside the reviews table: posts
 * to the Me acknowledge route and refreshes on success, rendering the
 * service refusal inline. Rows that cannot acknowledge render nothing. */
export function ReviewAcknowledgeButton({
  reviewId,
  label,
  canAcknowledge,
  failedLabel,
}: {
  reviewId: string
  label: string
  canAcknowledge: boolean
  failedLabel: string
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  if (!reviewId || !canAcknowledge) return null
  const acknowledge = async (): Promise<void> => {
    setBusy(true)
    setStatus(null)
    try {
      const res = await fetch('/api/hrm/me/reviews/acknowledge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reviewId }),
      })
      if (!res.ok) {
        setStatus(await readApiErrorMessage(res, failedLabel))
        return
      }
      router.refresh()
    } catch {
      setStatus(failedLabel)
    } finally {
      setBusy(false)
    }
  }
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button size="sm" variant="outline" disabled={busy} onClick={acknowledge}>
        {label}
      </Button>
      {status ? <span className="text-xs text-red-600 dark:text-red-400">{status}</span> : null}
    </span>
  )
}

interface GoalProgressDialogStrings {
  goalId: string
  title: string
  description: string
  percentLabel: string
  noteLabel: string
  notePlaceholder: string
  submitLabel: string
  cancelLabel: string
  submitFailed: string
}

/** Goal progress dialog, opened from the goals table through the `goal`
 * search param; submit posts progress with a note to the Me route. */
export function GoalProgressDialog({
  dialog,
  closeHref,
}: {
  dialog: GoalProgressDialogStrings | null
  closeHref: string
}) {
  const router = useRouter()
  const [percent, setPercent] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  if (!dialog) return null
  const submit = async (): Promise<void> => {
    setBusy(true)
    setStatus(null)
    try {
      const res = await fetch('/api/hrm/me/goals/progress', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ goalId: dialog.goalId, progressPercent: Number(percent), note: note.trim() === '' ? null : note.trim() }),
      })
      if (!res.ok) {
        setStatus(await readApiErrorMessage(res, dialog.submitFailed))
        return
      }
      router.push(closeHref)
      router.refresh()
    } catch {
      setStatus(dialog.submitFailed)
    } finally {
      setBusy(false)
    }
  }
  return (
    <UrlDrawer open closeHref={closeHref} title={dialog.title} description={dialog.description}>
      <div className="flex flex-col gap-4 p-4">
        <div className="flex flex-col gap-1.5">
          <Label>{dialog.percentLabel}</Label>
          <Input inputMode="numeric" value={percent} onChange={(event) => setPercent(event.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>{dialog.noteLabel}</Label>
          <Textarea placeholder={dialog.notePlaceholder} value={note} onChange={(event) => setNote(event.target.value)} />
        </div>
        {status ? <p className="text-sm text-red-600 dark:text-red-400">{status}</p> : null}
        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" disabled={busy} onClick={() => router.push(closeHref)}>
            {dialog.cancelLabel}
          </Button>
          <Button disabled={busy} onClick={submit}>
            {dialog.submitLabel}
          </Button>
        </div>
      </div>
    </UrlDrawer>
  )
}

interface BenefitElectDialogStrings {
  title: string
  description: string
  employmentLabel: string
  employments: { value: string; label: string }[]
  planLabel: string
  plans: { value: string; label: string; levels: { value: string; label: string }[] }[]
  levelLabel: string
  windowLabel: string
  windows: { value: string; label: string }[]
  fromLabel: string
  lifeEventLabel: string
  lifeEventPlaceholder: string
  submitLabel: string
  cancelLabel: string
  submitFailed: string
}

/** Elect-coverage dialog, opened from the benefits header through the
 * `elect` search param; submit elects through the Me route with the
 * service refusal inline. */
export function BenefitElectDialog({
  dialog,
  closeHref,
}: {
  dialog: BenefitElectDialogStrings | null
  closeHref: string
}) {
  const router = useRouter()
  const [employmentId, setEmploymentId] = useState('')
  const [planId, setPlanId] = useState('')
  const [levelKey, setLevelKey] = useState('')
  const [windowId, setWindowId] = useState('')
  const [from, setFrom] = useState('')
  const [lifeEvent, setLifeEvent] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  if (!dialog) return null
  const levels = dialog.plans.find((plan) => plan.value === planId)?.levels ?? []
  const submit = async (): Promise<void> => {
    const boundEmployment =
      employmentId || (dialog.employments.length === 1 ? (dialog.employments[0]?.value ?? '') : '')
    if (!boundEmployment || !planId || from.trim() === '') {
      setStatus(dialog.submitFailed)
      return
    }
    setBusy(true)
    setStatus(null)
    try {
      const res = await fetch('/api/hrm/me/benefits/elect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          employmentId: boundEmployment,
          planId,
          windowId: windowId === '' ? null : windowId,
          coverageLevelKey: levelKey === '' ? null : levelKey,
          effectiveFrom: from.trim(),
          lifeEventReason: lifeEvent.trim() === '' ? null : lifeEvent.trim(),
        }),
      })
      if (!res.ok) {
        setStatus(await readApiErrorMessage(res, dialog.submitFailed))
        return
      }
      router.push(closeHref)
      router.refresh()
    } catch {
      setStatus(dialog.submitFailed)
    } finally {
      setBusy(false)
    }
  }
  return (
    <UrlDrawer open closeHref={closeHref} title={dialog.title} description={dialog.description}>
      <div className="flex flex-col gap-4 p-4">
        {dialog.employments.length > 1 ? (
          <div className="flex flex-col gap-1.5">
            <Label>{dialog.employmentLabel}</Label>
            <Select value={employmentId} onChange={(event) => setEmploymentId(event.target.value)}>
              <option value="">{dialog.employmentLabel}</option>
              {dialog.employments.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        <div className="flex flex-col gap-1.5">
          <Label>{dialog.planLabel}</Label>
          <Select value={planId} onChange={(event) => { setPlanId(event.target.value); setLevelKey('') }}>
            <option value="">{dialog.planLabel}</option>
            {dialog.plans.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>
        {levels.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <Label>{dialog.levelLabel}</Label>
            <Select value={levelKey} onChange={(event) => setLevelKey(event.target.value)}>
              <option value="">{dialog.levelLabel}</option>
              {levels.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        <div className="flex flex-col gap-1.5">
          <Label>{dialog.windowLabel}</Label>
          <Select value={windowId} onChange={(event) => setWindowId(event.target.value)}>
            <option value="">{dialog.windowLabel}</option>
            {dialog.windows.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>{dialog.fromLabel}</Label>
          <Input value={from} placeholder="2026-04-01" onChange={(event) => setFrom(event.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>{dialog.lifeEventLabel}</Label>
          <Textarea placeholder={dialog.lifeEventPlaceholder} value={lifeEvent} onChange={(event) => setLifeEvent(event.target.value)} />
        </div>
        {status ? <p className="text-sm text-red-600 dark:text-red-400">{status}</p> : null}
        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" disabled={busy} onClick={() => router.push(closeHref)}>
            {dialog.cancelLabel}
          </Button>
          <Button disabled={busy} onClick={submit}>
            {dialog.submitLabel}
          </Button>
        </div>
      </div>
    </UrlDrawer>
  )
}

interface BenefitChangeDialogStrings {
  enrollmentId: string
  planName: string
  title: string
  description: string
  levelLabel: string
  levels: { value: string; label: string }[]
  dateLabel: string
  reasonLabel: string
  reasonPlaceholder: string
  submitLabel: string
  cancelLabel: string
  submitFailed: string
}

/** Change-coverage dialog, opened from an active election row through the
 * `change` search param; submit changes from a date inside an open
 * window through the Me route. */
export function BenefitChangeDialog({
  dialog,
  closeHref,
}: {
  dialog: BenefitChangeDialogStrings | null
  closeHref: string
}) {
  const router = useRouter()
  const [levelKey, setLevelKey] = useState('')
  const [date, setDate] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  if (!dialog) return null
  const submit = async (): Promise<void> => {
    if (date.trim() === '' || reason.trim() === '') {
      setStatus(dialog.submitFailed)
      return
    }
    setBusy(true)
    setStatus(null)
    try {
      const res = await fetch('/api/hrm/me/benefits/change', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          enrollmentId: dialog.enrollmentId,
          changeDate: date.trim(),
          coverageLevelKey: levelKey === '' ? null : levelKey,
          reason: reason.trim(),
        }),
      })
      if (!res.ok) {
        setStatus(await readApiErrorMessage(res, dialog.submitFailed))
        return
      }
      router.push(closeHref)
      router.refresh()
    } catch {
      setStatus(dialog.submitFailed)
    } finally {
      setBusy(false)
    }
  }
  return (
    <UrlDrawer open closeHref={closeHref} title={dialog.title} description={`${dialog.planName} — ${dialog.description}`}>
      <div className="flex flex-col gap-4 p-4">
        {dialog.levels.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <Label>{dialog.levelLabel}</Label>
            <Select value={levelKey} onChange={(event) => setLevelKey(event.target.value)}>
              <option value="">{dialog.levelLabel}</option>
              {dialog.levels.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        <div className="flex flex-col gap-1.5">
          <Label>{dialog.dateLabel}</Label>
          <Input value={date} placeholder="2026-04-01" onChange={(event) => setDate(event.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>{dialog.reasonLabel}</Label>
          <Textarea placeholder={dialog.reasonPlaceholder} value={reason} onChange={(event) => setReason(event.target.value)} />
        </div>
        {status ? <p className="text-sm text-red-600 dark:text-red-400">{status}</p> : null}
        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" disabled={busy} onClick={() => router.push(closeHref)}>
            {dialog.cancelLabel}
          </Button>
          <Button disabled={busy} onClick={submit}>
            {dialog.submitLabel}
          </Button>
        </div>
      </div>
    </UrlDrawer>
  )
}

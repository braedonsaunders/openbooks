'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { FieldControl } from '../admin/setup/[entity]/SetupDrawer'
import type { SetupField } from '../../../lib/setup/types'
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
  failedLabel: _failedLabel,
}: {
  stepId: string
  label: string
  failedLabel: string
}) {
  if (!stepId) return null
  return <Button asChild size="sm" variant="outline"><a href={`/me/checklists?step=${encodeURIComponent(stepId)}`}>{label}</a></Button>
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
            <Label htmlFor="me-contact-employment">{strings.employmentLabel}</Label>
            <Select id="me-contact-employment" value={employmentId} onChange={(event) => setEmploymentId(event.target.value)}>
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
            <Label htmlFor="me-contact-phone">{strings.phoneLabel}</Label>
            <Input id="me-contact-phone" value={phone} disabled={clearPhone} onChange={(event) => setPhone(event.target.value)} />
            <label className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
              <input type="checkbox" checked={clearPhone} onChange={(event) => setClearPhone(event.target.checked)} />
              {strings.clearHint}
            </label>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="me-contact-email">{strings.emailLabel}</Label>
            <Input id="me-contact-email" value={email} disabled={clearEmail} onChange={(event) => setEmail(event.target.value)} />
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
          <Label htmlFor="me-contact-reason">{strings.reasonLabel}</Label>
          <Textarea id="me-contact-reason" placeholder={strings.reasonPlaceholder} value={reason} onChange={(event) => setReason(event.target.value)} />
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
          <Label htmlFor="me-allocation-percent">{dialog.percentLabel}</Label>
          <Input id="me-allocation-percent" inputMode="numeric" value={percent} onChange={(event) => setPercent(event.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="me-allocation-note">{dialog.noteLabel}</Label>
          <Textarea id="me-allocation-note" placeholder={dialog.notePlaceholder} value={note} onChange={(event) => setNote(event.target.value)} />
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

export interface BenefitElectionRule { value: string; label: string; basis: string; rate: string; rateFormula: string; requiresMatchEligibility: boolean; effectiveFrom: string; effectiveTo: string | null }
type ContributionChoice = { electionMode: string; electedRate: string; declaredPeriodsPerYear?: string }

function BenefitContributionChoices({ rules, choices, onChange }: {
  rules: BenefitElectionRule[]; choices: Record<string, ContributionChoice>;
  onChange: (id: string, value: ContributionChoice) => void
}) {
  const t = useTranslations('admin.setup')
  const fields: SetupField[] = [
    { key: 'electionMode', kind: 'select', required: true, options: [{ value: 'fixed', labelKey: 'benefitContributions.options.election.fixed' }, { value: 'follows_policy', labelKey: 'benefitContributions.options.election.follows_policy' }], helpTextKey: 'benefitContributions.electionHint' },
    { key: 'electedRate', kind: 'decimal', required: true, helpTextKey: 'benefitContributions.electedRateHint' },
    { key: 'declaredPeriodsPerYear', kind: 'integer', min: 1, max: 366, helpTextKey: 'benefitContributions.annualizationHint' },
  ]
  return <div className="space-y-3">{rules.map((rule) => {
    const value = choices[rule.value] ?? { electionMode: '', electedRate: '' }
    return <fieldset key={rule.value} className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
      <legend className="px-1 text-sm font-medium">{rule.label}</legend>
      <p className="mb-3 text-xs text-slate-500">{t(`benefitContributions.options.basis.${rule.basis}`)} · {t('benefitContributions.planRate', { rate: rule.rate })}</p>
      <div className="grid gap-4 sm:grid-cols-2">{fields.filter((field) => (field.key !== 'electedRate' || value.electionMode === 'fixed') && (field.key !== 'declaredPeriodsPerYear' || ['per_month', 'per_year'].includes(rule.basis))).map((field) =>
        <FieldControl key={field.key} field={field} value={value[field.key as keyof ContributionChoice]} onChange={(next) => onChange(rule.value, { ...value, [field.key]: String(next ?? '') })} creating forceLocked={false} refOptions={[]} formValues={value} t={t} />
      )}</div>
    </fieldset>
  })}</div>
}

export interface BenefitElectDialogStrings {
  title: string
  description: string
  employmentLabel: string
  employments: { value: string; label: string }[]
  planLabel: string
  plans: { value: string; label: string; classes: { value: string; label: string }[]; contributionRules: BenefitElectionRule[] }[]
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
  mode = 'self',
}: {
  dialog: BenefitElectDialogStrings | null
  closeHref: string
  mode?: 'self' | 'manage'
}) {
  const router = useRouter()
  const [employmentId, setEmploymentId] = useState('')
  const [planId, setPlanId] = useState('')
  const [classKey, setClassKey] = useState('')
  const [matchEligible, setMatchEligible] = useState('')
  const [contributions, setContributions] = useState<Record<string, ContributionChoice>>({})
  const tSetup = useTranslations('admin.setup')
  const [windowId, setWindowId] = useState('')
  const [from, setFrom] = useState('')
  const [lifeEvent, setLifeEvent] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  if (!dialog) return null
  const selectedPlan = dialog.plans.find((plan) => plan.value === planId)
  const classes = selectedPlan?.classes ?? []
  const rules = (selectedPlan?.contributionRules ?? []).filter((rule) => !from || (rule.effectiveFrom <= from && (rule.effectiveTo === null || rule.effectiveTo >= from)))
  const submit = async (): Promise<void> => {
    if (rules.some(rule => rule.requiresMatchEligibility) && matchEligible === '') { setStatus(tSetup('validation.required', { field: tSetup('fields.matchEligible') })); return }
    const boundEmployment =
      employmentId || (dialog.employments.length === 1 ? (dialog.employments[0]?.value ?? '') : '')
    if (!boundEmployment || !planId || from.trim() === '' || rules.some((rule) => !contributions[rule.value]?.electionMode || (contributions[rule.value]?.electionMode === 'fixed' && !contributions[rule.value]?.electedRate.trim()))) {
      setStatus(dialog.submitFailed)
      return
    }
    setBusy(true)
    setStatus(null)
    try {
      const res = await fetch(mode === 'manage' ? '/api/hrm/enrollments' : '/api/hrm/me/benefits/elect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(mode === 'manage' ? { action: 'elect', selfService: false } : {}),
          employmentId: boundEmployment,
          planId,
          windowId: windowId === '' ? null : windowId,
          classKey: classKey || null,
          ...(matchEligible === '' ? {} : { matchEligible: matchEligible === 'true' }),
          contributionTerms: rules.map((rule) => ({ ruleId: rule.value, electionMode: contributions[rule.value]!.electionMode, ...(contributions[rule.value]!.electionMode === 'fixed' ? { electedRate: contributions[rule.value]!.electedRate } : {}), ...(contributions[rule.value]!.declaredPeriodsPerYear ? { declaredPeriodsPerYear: Number(contributions[rule.value]!.declaredPeriodsPerYear) } : {}) })),
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
        {mode === 'manage' || dialog.employments.length > 1 ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="me-elect-employment">{dialog.employmentLabel}</Label>
            <Select id="me-elect-employment" value={employmentId} onChange={(event) => setEmploymentId(event.target.value)}>
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
          <Label htmlFor="me-elect-plan">{dialog.planLabel}</Label>
          <Select id="me-elect-plan" value={planId} onChange={(event) => { setPlanId(event.target.value); setClassKey(''); setMatchEligible(''); setContributions({}) }}>
            <option value="">{dialog.planLabel}</option>
            {dialog.plans.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="me-elect-from">{dialog.fromLabel}</Label>
          <Input id="me-elect-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
        </div>
        {classes.length > 0 ? <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="me-elect-class">{tSetup('fields.classKey')}</Label>
            <Select id="me-elect-class" value={classKey} onChange={(event) => setClassKey(event.target.value)}>
              <option value="">{tSetup('fields.classKey')}</option>
              {classes.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </Select>
          </div>
        </> : null}
        {rules.some(rule => rule.requiresMatchEligibility) ? <FieldControl
          field={{ key: 'matchEligible', kind: 'boolean', nullable: true, required: true, helpTextKey: 'benefitContributions.matchHint' }}
          value={matchEligible === '' ? null : matchEligible === 'true'} onChange={next => setMatchEligible(next == null ? '' : String(next))}
          creating forceLocked={false} refOptions={[]} formValues={{}} t={tSetup}
        /> : null}
        <BenefitContributionChoices rules={rules} choices={contributions} onChange={(id, value) => setContributions((current) => ({ ...current, [id]: value }))} />
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="me-elect-window">{dialog.windowLabel}</Label>
          <Select id="me-elect-window" value={windowId} onChange={(event) => setWindowId(event.target.value)}>
            <option value="">{dialog.windowLabel}</option>
            {dialog.windows.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="me-elect-life-event">{dialog.lifeEventLabel}</Label>
          <Textarea id="me-elect-life-event" placeholder={dialog.lifeEventPlaceholder} value={lifeEvent} onChange={(event) => setLifeEvent(event.target.value)} />
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

export interface BenefitChangeDialogStrings {
  enrollmentId: string
  planName: string
  title: string
  description: string
  classKey: string | null
  matchEligible: boolean | null
  classes: { value: string; label: string }[]
  contributionRules: BenefitElectionRule[]
  contributionTerms: { ruleId: string; electionMode: 'fixed' | 'follows_policy'; electedRate: string | null; declaredPeriodsPerYear?: number | null }[]
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
  mode = 'self',
}: {
  dialog: BenefitChangeDialogStrings | null
  closeHref: string
  mode?: 'self' | 'manage'
}) {
  const router = useRouter()
  const [classKey, setClassKey] = useState(dialog?.classKey ?? '')
  const [matchEligible, setMatchEligible] = useState(dialog?.matchEligible == null ? '' : String(dialog.matchEligible))
  const [contributions, setContributions] = useState<Record<string, ContributionChoice>>(() => Object.fromEntries((dialog?.contributionTerms ?? []).map((term) => [term.ruleId, { electionMode: term.electionMode, electedRate: term.electedRate ?? '', declaredPeriodsPerYear: term.declaredPeriodsPerYear == null ? '' : String(term.declaredPeriodsPerYear) }])))
  const tSetup = useTranslations('admin.setup')
  const [date, setDate] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  if (!dialog) return null
  const rules = dialog.contributionRules.filter((rule) => !date || (rule.effectiveFrom <= date && (rule.effectiveTo === null || rule.effectiveTo >= date)))
  const submit = async (): Promise<void> => {
    if (rules.some(rule => rule.requiresMatchEligibility) && matchEligible === '') { setStatus(tSetup('validation.required', { field: tSetup('fields.matchEligible') })); return }
    if (date.trim() === '' || reason.trim() === '' || rules.some((rule) => !contributions[rule.value]?.electionMode || (contributions[rule.value]?.electionMode === 'fixed' && !contributions[rule.value]?.electedRate.trim()))) {
      setStatus(dialog.submitFailed)
      return
    }
    setBusy(true)
    setStatus(null)
    try {
      const res = await fetch(mode === 'manage' ? `/api/hrm/enrollments/${dialog.enrollmentId}` : '/api/hrm/me/benefits/change', {
        method: mode === 'manage' ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(mode === 'manage' ? { action: 'change' } : {}),
          ...(mode === 'self' ? { enrollmentId: dialog.enrollmentId } : {}),
          changeDate: date.trim(),
          classKey: classKey || null,
          ...(matchEligible === '' ? {} : { matchEligible: matchEligible === 'true' }),
          contributionTerms: rules.map((rule) => ({ ruleId: rule.value, electionMode: contributions[rule.value]!.electionMode, ...(contributions[rule.value]!.electionMode === 'fixed' ? { electedRate: contributions[rule.value]!.electedRate } : {}), ...(contributions[rule.value]!.declaredPeriodsPerYear ? { declaredPeriodsPerYear: Number(contributions[rule.value]!.declaredPeriodsPerYear) } : {}) })),
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
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="me-change-date">{dialog.dateLabel}</Label>
          <Input id="me-change-date" value={date} placeholder="2026-04-01" onChange={(event) => setDate(event.target.value)} />
        </div>
        {dialog.classes.length > 0 ? <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="me-change-class">{tSetup('fields.classKey')}</Label>
            <Select id="me-change-class" value={classKey} onChange={(event) => setClassKey(event.target.value)}><option value="">{tSetup('fields.classKey')}</option>{dialog.classes.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</Select>
          </div>
        </> : null}
        {rules.some(rule => rule.requiresMatchEligibility) ? <FieldControl
          field={{ key: 'matchEligible', kind: 'boolean', nullable: true, required: true, helpTextKey: 'benefitContributions.matchHint' }}
          value={matchEligible === '' ? null : matchEligible === 'true'} onChange={next => setMatchEligible(next == null ? '' : String(next))}
          creating forceLocked={false} refOptions={[]} formValues={{}} t={tSetup}
        /> : null}
        <BenefitContributionChoices rules={rules} choices={contributions} onChange={(id, value) => setContributions((current) => ({ ...current, [id]: value }))} />
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="me-change-reason">{dialog.reasonLabel}</Label>
          <Textarea id="me-change-reason" placeholder={dialog.reasonPlaceholder} value={reason} onChange={(event) => setReason(event.target.value)} />
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

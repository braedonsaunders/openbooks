'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button, Drawer, Input, Label, SearchSelect, Select, Textarea } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../lib/api-error'
import { useBusinessToday } from '../../../components/business-date-provider'

/**
 * Native employment change-request authoring. Opens from the Employment tab
 * behind hrm.employment.manage (the API re-checks the grant): a kind
 * selector plus kind-specific fields that mirror the zod payload contract in
 * engine/src/hrm/change-requests.ts field for field — hire, status_change,
 * assignment_change (including the line-manager repoint), termination, and
 * position_assignment (the establishment link, with an unassign mode that
 * posts an explicit null). The position picker reads source=positions
 * behind hrm.position.read; without that grant the picker reports the
 * refusal instead of a roster.
 *
 * Civil dates travel verbatim: the date controls yield YYYY-MM-DD strings
 * and the payload carries them untouched, never through a Date. FTE posts as
 * the exact typed decimal text. Every API refusal renders with its message
 * intact — res.ok is checked before parsing, failures toast and render
 * inline, and nothing is swallowed. Approval outcomes stay in native
 * Approvals: this surface only files, edits, submits, and withdraws.
 */

export type ChangeRequestKind = 'hire' | 'status_change' | 'assignment_change' | 'termination' | 'position_assignment'

export type DepartmentOption = {
  value: string
  label: string
}

/** One remote picker row from the HRM options route (manager or location). */
export type PickerOption = {
  value: string
  label: string
}

export type EditableChangeRequest = {
  id: string
  payload: Record<string, unknown>
}

const KINDS: ChangeRequestKind[] = ['hire', 'status_change', 'assignment_change', 'termination', 'position_assignment']

/** Generic HR actions (0227) classing every change request while hrmActionReasons is on. */
const HRM_ACTIONS = [
  'hire', 'rehire', 'transfer', 'promotion', 'demotion', 'pay_change',
  'manager_change', 'location_change', 'schedule_change',
  'leave_of_absence', 'return', 'termination', 'profile_change', 'other',
]

const HIRE_STATUSES = ['offered', 'active', 'on_leave', 'suspended'] as const
const ALL_STATUSES = ['offered', 'active', 'on_leave', 'suspended', 'terminated'] as const

function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function ChangeRequestDrawer({
  employmentId,
  initialRequest,
  departmentOptions,
  onClose,
  onSaved,
}: {
  employmentId: string
  /** Set when editing a draft; null when proposing a new change. */
  initialRequest: EditableChangeRequest | null
  departmentOptions: DepartmentOption[]
  onClose: () => void
  onSaved: () => void
}) {
  const t = useTranslations('hrm')
  const tCommon = useTranslations('common')
  const router = useRouter()
  // New dated requests default to the org's business day from the server,
  // never the browser's UTC day (tomorrow after 5pm Pacific).
  const today = useBusinessToday()
  const editing = initialRequest !== null
  const initialPayload = (initialRequest?.payload ?? {}) as Record<string, unknown>

  const [kind, setKind] = useState<ChangeRequestKind>(
    initialPayload.kind === 'status_change' ||
      initialPayload.kind === 'assignment_change' ||
      initialPayload.kind === 'termination' ||
      initialPayload.kind === 'position_assignment'
      ? initialPayload.kind
      : 'hire',
  )
  const [status, setStatus] = useState(asText(initialPayload.status) || 'active')
  const [effectiveFrom, setEffectiveFrom] = useState(asText(initialPayload.effectiveFrom) || today)
  const [effectiveTo, setEffectiveTo] = useState(asText(initialPayload.effectiveTo))
  const [effectiveDate, setEffectiveDate] = useState(asText(initialPayload.effectiveDate) || today)
  const [assignmentKey, setAssignmentKey] = useState(asText(initialPayload.assignmentKey))
  const [jobTitle, setJobTitle] = useState(asText(initialPayload.jobTitle))
  const [departmentId, setDepartmentId] = useState(asText(initialPayload.departmentId))
  const [locationId, setLocationId] = useState(asText(initialPayload.locationId))
  const [locationOptions, setLocationOptions] = useState<PickerOption[]>([])
  const [locationQuery, setLocationQuery] = useState('')
  const [locationLoading, setLocationLoading] = useState(true)
  const [locationStatus, setLocationStatus] = useState<string | undefined>(undefined)
  const [fte, setFte] = useState(asText(initialPayload.fte))
  const [primary, setPrimary] = useState(
    initialPayload.isPrimary === true ? 'yes' : initialPayload.isPrimary === false ? 'no' : 'unchanged',
  )
  const [managerEmploymentId, setManagerEmploymentId] = useState(asText(initialPayload.managerEmploymentId))
  const [positionId, setPositionId] = useState(asText(initialPayload.positionId))
  const [unassign, setUnassign] = useState(
    initialPayload.kind === 'position_assignment' && (initialPayload as { positionId?: unknown }).positionId === null,
  )
  const [positionOptions, setPositionOptions] = useState<PickerOption[]>([])
  const [positionQuery, setPositionQuery] = useState('')
  const [positionLoading, setPositionLoading] = useState(true)
  const [positionStatus, setPositionStatus] = useState<string | undefined>(undefined)
  const [managerOptions, setManagerOptions] = useState<PickerOption[]>([])
  const [managerQuery, setManagerQuery] = useState('')
  const [managerLoading, setManagerLoading] = useState(true)
  const [managerStatus, setManagerStatus] = useState<string | undefined>(undefined)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // HR-16 begin: action/reason classification (0227). reasonsOn false = the
  // hrmActionReasons feature is off: the selects hide and submit ignores
  // classification entirely.
  const [action, setAction] = useState('')
  const [reasonCode, setReasonCode] = useState('')
  const [reasonsOn, setReasonsOn] = useState(false)
  const [reasonOptions, setReasonOptions] = useState<{ action: string; reasonCode: string; label: string }[]>([])
  const managerRequestId = useRef(0)
  const locationRequestId = useRef(0)
  const positionRequestId = useRef(0)

  // Remote per-query pickers over the HRM options route: bounded page per
  // query so holders beyond the first page stay selectable. A sequence
  // guard drops stale responses, and the draft's stored value pins first
  // under edit through the route's include parameter (merged back when the
  // page does not contain it).
  useEffect(() => {
    const id = (managerRequestId.current += 1)
    const params = new URLSearchParams()
    params.set('source', 'employments')
    params.set('limit', '25')
    if (managerQuery.trim()) params.set('q', managerQuery.trim())
    if (managerEmploymentId) params.set('include', managerEmploymentId)
    fetch(`/api/hrm/options?${params.toString()}`, { method: 'GET' })
      .then(async (res) => {
        if (id !== managerRequestId.current) return
        if (!res.ok) {
          setManagerStatus(await readApiErrorMessage(res, t('employment.changeRequests.requestFailed')))
          setManagerLoading(false)
          return
        }
        const payload = (await res.json().catch(() => ({}))) as {
          options?: { employmentId?: unknown; label?: unknown }[]
        }
        if (id !== managerRequestId.current) return
        const page = Array.isArray(payload.options) ? payload.options : []
        const merged: PickerOption[] = []
        for (const row of page) {
          if (typeof row.employmentId === 'string' && typeof row.label === 'string') {
            merged.push({ value: row.employmentId, label: row.label })
          }
        }
        if (managerEmploymentId && !merged.some((option) => option.value === managerEmploymentId)) {
          merged.push({ value: managerEmploymentId, label: managerEmploymentId })
        }
        setManagerOptions(merged)
        setManagerStatus(undefined)
        setManagerLoading(false)
      })
      .catch(() => {
        if (id !== managerRequestId.current) return
        setManagerStatus(t('employment.changeRequests.requestFailed'))
        setManagerLoading(false)
      })
  }, [managerQuery, managerEmploymentId, t])

  useEffect(() => {
    const id = (locationRequestId.current += 1)
    const params = new URLSearchParams()
    params.set('source', 'locations')
    params.set('limit', '25')
    if (locationQuery.trim()) params.set('q', locationQuery.trim())
    if (locationId) params.set('include', locationId)
    fetch(`/api/hrm/options?${params.toString()}`, { method: 'GET' })
      .then(async (res) => {
        if (id !== locationRequestId.current) return
        if (!res.ok) {
          setLocationStatus(await readApiErrorMessage(res, t('employment.changeRequests.requestFailed')))
          setLocationLoading(false)
          return
        }
        const payload = (await res.json().catch(() => ({}))) as {
          options?: { locationId?: unknown; label?: unknown }[]
        }
        if (id !== locationRequestId.current) return
        const page = Array.isArray(payload.options) ? payload.options : []
        const merged: PickerOption[] = []
        for (const row of page) {
          if (typeof row.locationId === 'string' && typeof row.label === 'string') {
            merged.push({ value: row.locationId, label: row.label })
          }
        }
        if (locationId && !merged.some((option) => option.value === locationId)) {
          merged.push({ value: locationId, label: locationId })
        }
        setLocationOptions(merged)
        setLocationStatus(undefined)
        setLocationLoading(false)
      })
      .catch(() => {
        if (id !== locationRequestId.current) return
        setLocationStatus(t('employment.changeRequests.requestFailed'))
        setLocationLoading(false)
      })
  }, [locationQuery, locationId, t])

  // The establishment picker over source=positions (position read grant):
  // same bounded-page, sequence-guarded, pin-first composition as the
  // manager and location pickers. A refusal (no position read grant) lands
  // in the picker status line with its message, never as an empty list.
  // HR-16: reason codes load once; a 404 means the hrmActionReasons feature
  // is off and the selects stay hidden (submit then ignores classification).
  useEffect(() => {
    const id = (positionRequestId.current += 1)
    const params = new URLSearchParams()
    params.set('source', 'positions')
    params.set('limit', '25')
    if (positionQuery.trim()) params.set('q', positionQuery.trim())
    if (positionId) params.set('include', positionId)
    fetch(`/api/hrm/options?${params.toString()}`, { method: 'GET' })
      .then(async (res) => {
        if (id !== positionRequestId.current) return
        if (!res.ok) {
          setPositionStatus(await readApiErrorMessage(res, t('employment.changeRequests.requestFailed')))
          setPositionLoading(false)
          return
        }
        const payload = (await res.json().catch(() => ({}))) as {
          options?: { positionId?: unknown; label?: unknown }[]
        }
        if (id !== positionRequestId.current) return
        const page = Array.isArray(payload.options) ? payload.options : []
        const merged: PickerOption[] = []
        for (const row of page) {
          if (typeof row.positionId === 'string' && typeof row.label === 'string') {
            merged.push({ value: row.positionId, label: row.label })
          }
        }
        if (positionId && !merged.some((option) => option.value === positionId)) {
          merged.push({ value: positionId, label: positionId })
        }
        setPositionOptions(merged)
        setPositionStatus(undefined)
        setPositionLoading(false)
      })
      .catch(() => {
        if (id !== positionRequestId.current) return
        setPositionStatus(t('employment.changeRequests.requestFailed'))
        setPositionLoading(false)
      })
  }, [positionQuery, positionId, t])

  useEffect(() => {
    fetch('/api/hrm/action-reasons', { method: 'GET' })
      .then(async (res) => {
        if (!res.ok) return
        const payload = (await res.json().catch(() => ({}))) as {
          reasons?: { action?: unknown; reasonCode?: unknown; label?: unknown }[]
        }
        const list = Array.isArray(payload.reasons) ? payload.reasons : []
        const valid = list.filter(
          (r) => typeof r.action === 'string' && typeof r.reasonCode === 'string' && typeof r.label === 'string',
        ) as { action: string; reasonCode: string; label: string }[]
        setReasonOptions(valid)
        setReasonsOn(true)
      })
      .catch(() => {
        // Unreachable route or network failure: classification stays off
        // and submit ignores it, never a refusal for a hidden control.
      })
  }, [])

  const kindLabel = (value: ChangeRequestKind): string =>
    value === 'hire'
      ? t('employment.changeRequests.kindHire')
      : value === 'status_change'
        ? t('employment.changeRequests.kindStatusChange')
        : value === 'assignment_change'
          ? t('employment.changeRequests.kindAssignmentChange')
          : value === 'termination'
            ? t('employment.changeRequests.kindTermination')
            : t('employment.changeRequests.kindPositionAssignment')

  const statusLabel = (value: string): string =>
    t.has(`employment.status.${value}`) ? t(`employment.status.${value}`) : value

  /** The exact payload the zod contract validates — unset fields are omitted. */
  function buildPayload(): Record<string, unknown> {
    if (kind === 'hire' || kind === 'status_change') {
      return {
        kind,
        status,
        effectiveFrom,
        ...(effectiveTo.trim() ? { effectiveTo: effectiveTo.trim() } : {}),
      }
    }
    if (kind === 'termination') {
      return { kind, effectiveDate }
    }
    if (kind === 'position_assignment') {
      return {
        kind,
        assignmentKey: assignmentKey.trim(),
        positionId: unassign ? null : positionId,
        ...(effectiveFrom.trim() ? { effectiveFrom: effectiveFrom.trim() } : {}),
        ...(effectiveTo.trim() ? { effectiveTo: effectiveTo.trim() } : {}),
      }
    }
    return {
      kind,
      assignmentKey: assignmentKey.trim(),
      ...(jobTitle.trim() ? { jobTitle: jobTitle.trim() } : {}),
      ...(departmentId ? { departmentId } : {}),
      ...(locationId ? { locationId } : {}),
      ...(fte.trim() ? { fte: fte.trim() } : {}),
      ...(primary === 'unchanged' ? {} : { isPrimary: primary === 'yes' }),
      ...(effectiveFrom.trim() ? { effectiveFrom: effectiveFrom.trim() } : {}),
      ...(effectiveTo.trim() ? { effectiveTo: effectiveTo.trim() } : {}),
      ...(managerEmploymentId ? { managerEmploymentId } : {}),
    }
  }

  async function postCreate(payload: Record<string, unknown>): Promise<string | null> {
    const res = await fetch(`/api/hrm/change-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employmentId, payload }),
    })
    if (!res.ok) {
      const message = await readApiErrorMessage(res, t('employment.changeRequests.requestFailed'))
      setError(message)
      toast.error(message)
      return null
    }
    const data = await res.json().catch(() => ({}))
    const id = (data as { request?: { id?: unknown } }).request?.id
    return typeof id === 'string' ? id : null
  }

  async function patchDraft(requestId: string, payload: Record<string, unknown>): Promise<boolean> {
    const res = await fetch(`/api/hrm/change-requests/${requestId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload }),
    })
    if (!res.ok) {
      const message = await readApiErrorMessage(res, t('employment.changeRequests.requestFailed'))
      setError(message)
      toast.error(message)
      return false
    }
    await res.json().catch(() => ({}))
    return true
  }

  async function submitDraft(requestId: string, submitReason: string): Promise<boolean> {
    // HR-16: classification rides submit only while the feature is on.
    if (reasonsOn && !action) {
      setError(t('employment.changeRequests.actionRequired'))
      return false
    }
    const res = await fetch(`/api/hrm/change-requests/${requestId}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reason: submitReason,
        ...(reasonsOn && action ? { action, ...(reasonCode ? { reasonCode } : {}) } : {}),
      }),
    })
    if (!res.ok) {
      const message = await readApiErrorMessage(res, t('employment.changeRequests.requestFailed'))
      setError(message)
      toast.error(message)
      return false
    }
    await res.json().catch(() => ({}))
    return true
  }

  function requireAssignmentKey(): boolean {
    if ((kind === 'assignment_change' || kind === 'position_assignment') && !assignmentKey.trim()) {
      setError(t('employment.changeRequests.assignmentKeyRequired'))
      return false
    }
    return true
  }

  function requirePositionLink(): boolean {
    if (kind === 'position_assignment' && !unassign && !positionId) {
      setError(t('employment.changeRequests.positionRequired'))
      return false
    }
    return true
  }

  function requireReason(): string | null {
    if (!reason.trim()) {
      setError(t('employment.changeRequests.reasonRequired'))
      return null
    }
    return reason.trim()
  }

  async function saveDraft() {
    if (!requireAssignmentKey()) return
    if (!requirePositionLink()) return
    setBusy(true)
    setError(null)
    const payload = buildPayload()
    let ok = false
    if (editing && initialRequest) {
      ok = await patchDraft(initialRequest.id, payload)
      if (ok) toast.success(t('employment.changeRequests.updatedToast'))
    } else {
      ok = (await postCreate(payload)) !== null
      if (ok) toast.success(t('employment.changeRequests.savedDraftToast'))
    }
    setBusy(false)
    if (ok) {
      onClose()
      onSaved()
      router.refresh()
    }
  }

  async function submitForApproval() {
    if (!requireAssignmentKey()) return
    if (!requirePositionLink()) return
    const submitReason = requireReason()
    if (submitReason === null) return
    setBusy(true)
    setError(null)
    const payload = buildPayload()
    let requestId: string | null = null
    if (editing && initialRequest) {
      requestId = (await patchDraft(initialRequest.id, payload)) ? initialRequest.id : null
    } else {
      requestId = await postCreate(payload)
    }
    const submitted = requestId !== null && (await submitDraft(requestId, submitReason))
    setBusy(false)
    if (submitted) {
      toast.success(t('employment.changeRequests.submittedToast'))
      onClose()
      onSaved()
      router.refresh()
    }
  }

  const statusOptions = kind === 'hire' ? HIRE_STATUSES : ALL_STATUSES

  return (
    <Drawer
      open
      onClose={onClose}
      size="md"
      title={t(editing ? 'employment.changeRequests.titleEdit' : 'employment.changeRequests.titleNew')}
      description={t('employment.changeRequests.authoringDescription')}
      headerActions={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {tCommon('actions.cancel')}
          </Button>
          <Button variant="outline" disabled={busy} onClick={saveDraft}>
            {t(editing ? 'employment.changeRequests.saveChanges' : 'employment.changeRequests.saveDraft')}
          </Button>
          <Button disabled={busy} onClick={submitForApproval}>
            {t('employment.changeRequests.submitForApproval')}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="space-y-1.5">
          <Label htmlFor="cr-kind">{t('employment.changeRequests.kindLabel')}</Label>
          <Select
            id="cr-kind"
            value={kind}
            disabled={busy}
            onChange={(event) => {
              setKind(event.target.value as ChangeRequestKind)
              setError(null)
            }}
          >
            {KINDS.map((option) => (
              <option key={option} value={option}>
                {kindLabel(option)}
              </option>
            ))}
          </Select>
        </div>

        {kind === 'hire' || kind === 'status_change' ? (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="cr-status">{t('employment.changeRequests.statusLabel')}</Label>
              <Select
                id="cr-status"
                value={status}
                disabled={busy}
                onChange={(event) => setStatus(event.target.value)}
              >
                {statusOptions.map((option) => (
                  <option key={option} value={option}>
                    {statusLabel(option)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cr-effective-from">{t('employment.changeRequests.effectiveFromLabel')}</Label>
              <input
                id="cr-effective-from"
                type="date"
                value={effectiveFrom}
                disabled={busy}
                required
                onChange={(event) => event.target.value && setEffectiveFrom(event.target.value)}
                className="w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cr-effective-to">{t('employment.changeRequests.effectiveToLabel')}</Label>
              <input
                id="cr-effective-to"
                type="date"
                value={effectiveTo}
                disabled={busy}
                onChange={(event) => setEffectiveTo(event.target.value)}
                className="w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              />
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {t('employment.changeRequests.effectiveToHint')}
              </p>
            </div>
          </>
        ) : null}

        {kind === 'assignment_change' ? (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="cr-assignment-key">{t('employment.changeRequests.assignmentKeyLabel')}</Label>
              <Input
                id="cr-assignment-key"
                value={assignmentKey}
                disabled={busy}
                required
                onChange={(event) => setAssignmentKey(event.target.value)}
                placeholder={t('employment.changeRequests.assignmentKeyPlaceholder')}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cr-job-title">{t('employment.changeRequests.jobTitleLabel')}</Label>
              <Input
                id="cr-job-title"
                value={jobTitle}
                disabled={busy}
                onChange={(event) => setJobTitle(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cr-department">{t('employment.changeRequests.departmentLabel')}</Label>
              <SearchSelect
                id="cr-department"
                value={departmentId}
                onChange={(next) => setDepartmentId(next)}
                options={departmentOptions}
                ariaLabel={t('employment.changeRequests.departmentLabel')}
                sheetTitle={t('employment.changeRequests.departmentLabel')}
                clearable
                emptyLabel={t('employment.changeRequests.departmentUnset')}
                disabled={busy}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cr-location">{t('employment.changeRequests.locationLabel')}</Label>
              <SearchSelect
                id="cr-location"
                value={locationId}
                onChange={(next) => {
                  setLocationId(next)
                  setError(null)
                }}
                options={locationOptions}
                ariaLabel={t('employment.changeRequests.locationLabel')}
                sheetTitle={t('employment.changeRequests.locationLabel')}
                clearable
                emptyLabel={t('employment.changeRequests.locationUnset')}
                remote
                loading={locationLoading}
                statusMessage={locationStatus}
                statusTone={locationStatus ? 'error' : 'muted'}
                onSearchChange={(next) => {
                  setLocationQuery(next)
                  setLocationLoading(true)
                  setLocationStatus(undefined)
                }}
                disabled={busy}
              />
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {t('employment.changeRequests.locationHint')}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cr-fte">{t('employment.changeRequests.fteLabel')}</Label>
              <Input
                id="cr-fte"
                value={fte}
                disabled={busy}
                inputMode="decimal"
                onChange={(event) => setFte(event.target.value)}
              />
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {t('employment.changeRequests.fteHint')}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cr-primary">{t('employment.changeRequests.primaryLabel')}</Label>
              <Select
                id="cr-primary"
                value={primary}
                disabled={busy}
                onChange={(event) => setPrimary(event.target.value)}
              >
                <option value="unchanged">{t('employment.changeRequests.primaryUnchanged')}</option>
                <option value="yes">{t('employment.changeRequests.primaryYes')}</option>
                <option value="no">{t('employment.changeRequests.primaryNo')}</option>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cr-manager">{t('employment.changeRequests.managerLabel')}</Label>
              <SearchSelect
                id="cr-manager"
                value={managerEmploymentId}
                onChange={(next) => {
                  setManagerEmploymentId(next)
                  setError(null)
                }}
                options={managerOptions}
                ariaLabel={t('employment.changeRequests.managerLabel')}
                sheetTitle={t('employment.changeRequests.managerLabel')}
                clearable
                emptyLabel={t('employment.changeRequests.managerUnset')}
                remote
                loading={managerLoading}
                statusMessage={managerStatus}
                statusTone={managerStatus ? 'error' : 'muted'}
                onSearchChange={(next) => {
                  setManagerQuery(next)
                  setManagerLoading(true)
                  setManagerStatus(undefined)
                }}
                disabled={busy}
              />
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {t('employment.changeRequests.managerHint')}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cr-assignment-from">{t('employment.changeRequests.effectiveFromLabel')}</Label>
              <input
                id="cr-assignment-from"
                type="date"
                value={effectiveFrom}
                disabled={busy}
                onChange={(event) => setEffectiveFrom(event.target.value)}
                className="w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cr-assignment-to">{t('employment.changeRequests.effectiveToLabel')}</Label>
              <input
                id="cr-assignment-to"
                type="date"
                value={effectiveTo}
                disabled={busy}
                onChange={(event) => setEffectiveTo(event.target.value)}
                className="w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              />
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {t('employment.changeRequests.effectiveToHint')}
              </p>
            </div>
          </>
        ) : null}

        {kind === 'termination' ? (
          <div className="space-y-1.5">
            <Label htmlFor="cr-effective-date">{t('employment.changeRequests.effectiveDateLabel')}</Label>
            <input
              id="cr-effective-date"
              type="date"
              value={effectiveDate}
              disabled={busy}
              required
              onChange={(event) => event.target.value && setEffectiveDate(event.target.value)}
              className="w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            />
          </div>
        ) : null}

        {kind === 'position_assignment' ? (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="cr-position-assignment-key">{t('employment.changeRequests.assignmentKeyLabel')}</Label>
              <Input
                id="cr-position-assignment-key"
                value={assignmentKey}
                disabled={busy}
                required
                onChange={(event) => setAssignmentKey(event.target.value)}
                placeholder={t('employment.changeRequests.assignmentKeyPlaceholder')}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cr-position">{t('employment.changeRequests.positionLabel')}</Label>
              <SearchSelect
                id="cr-position"
                value={unassign ? '' : positionId}
                onChange={(next) => {
                  setPositionId(next)
                  setError(null)
                }}
                options={positionOptions}
                ariaLabel={t('employment.changeRequests.positionLabel')}
                sheetTitle={t('employment.changeRequests.positionLabel')}
                clearable
                emptyLabel={t('employment.changeRequests.positionUnset')}
                remote
                loading={positionLoading}
                statusMessage={positionStatus}
                statusTone={positionStatus ? 'error' : 'muted'}
                onSearchChange={(next) => {
                  setPositionQuery(next)
                  setPositionLoading(true)
                  setPositionStatus(undefined)
                }}
                disabled={busy || unassign}
              />
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {t('employment.changeRequests.positionHint')}
              </p>
            </div>
            <div className="space-y-1.5">
              <label className="flex items-center gap-2 text-sm text-slate-900 dark:text-slate-100">
                <input
                  id="cr-unassign"
                  type="checkbox"
                  checked={unassign}
                  disabled={busy}
                  onChange={(event) => {
                    setUnassign(event.target.checked)
                    setError(null)
                  }}
                />
                {t('employment.changeRequests.unassignLabel')}
              </label>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {t('employment.changeRequests.unassignHint')}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cr-position-from">{t('employment.changeRequests.effectiveFromLabel')}</Label>
              <input
                id="cr-position-from"
                type="date"
                value={effectiveFrom}
                disabled={busy}
                onChange={(event) => setEffectiveFrom(event.target.value)}
                className="w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cr-position-to">{t('employment.changeRequests.effectiveToLabel')}</Label>
              <input
                id="cr-position-to"
                type="date"
                value={effectiveTo}
                disabled={busy}
                onChange={(event) => setEffectiveTo(event.target.value)}
                className="w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              />
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {t('employment.changeRequests.effectiveToHint')}
              </p>
            </div>
          </>
        ) : null}

        {reasonsOn ? (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="cr-action">{t('employment.changeRequests.actionLabel')}</Label>
              <Select
                id="cr-action"
                value={action}
                disabled={busy}
                onChange={(event) => {
                  setAction(event.target.value)
                  setReasonCode('')
                  setError(null)
                }}
              >
                <option value="">{t('employment.changeRequests.actionPlaceholder')}</option>
                {HRM_ACTIONS.map((option) => (
                  <option key={option} value={option}>
                    {t.has(`options.hrmAction.${option}`) ? t(`options.hrmAction.${option}`) : option}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cr-reason-code">{t('employment.changeRequests.reasonCodeLabel')}</Label>
              <Select
                id="cr-reason-code"
                value={reasonCode}
                disabled={busy || !action}
                onChange={(event) => {
                  setReasonCode(event.target.value)
                  setError(null)
                }}
              >
                <option value="">{t('employment.changeRequests.reasonCodePlaceholder')}</option>
                {reasonOptions
                  .filter((r) => r.action === action)
                  .map((r) => (
                    <option key={r.reasonCode} value={r.reasonCode}>
                      {r.label}
                    </option>
                  ))}
              </Select>
            </div>
          </>
        ) : null}
        <div className="space-y-1.5">
          <Label htmlFor="cr-reason">{t('employment.changeRequests.reasonLabel')}</Label>
          <Textarea
            id="cr-reason"
            value={reason}
            disabled={busy}
            onChange={(event) => setReason(event.target.value)}
            placeholder={t('employment.changeRequests.reasonPlaceholder')}
          />
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {t('employment.changeRequests.reasonSubmitNote')}
          </p>
        </div>

        {error ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        ) : null}
      </div>
    </Drawer>
  )
}

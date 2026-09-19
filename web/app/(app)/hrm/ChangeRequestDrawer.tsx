'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button, Drawer, Input, Label, SearchSelect, Select, Textarea } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../lib/api-error'

/**
 * Native employment change-request authoring. Opens from the Employment tab
 * behind hrm.employment.manage (the API re-checks the grant): a kind
 * selector plus kind-specific fields that mirror the zod payload contract in
 * engine/src/hrm/change-requests.ts field for field — hire, status_change,
 * assignment_change (including the line-manager repoint), termination.
 *
 * Civil dates travel verbatim: the date controls yield YYYY-MM-DD strings
 * and the payload carries them untouched, never through a Date. FTE posts as
 * the exact typed decimal text. Every API refusal renders with its message
 * intact — res.ok is checked before parsing, failures toast and render
 * inline, and nothing is swallowed. Approval outcomes stay in native
 * Approvals: this surface only files, edits, submits, and withdraws.
 */

export type ChangeRequestKind = 'hire' | 'status_change' | 'assignment_change' | 'termination'

export type DepartmentOption = {
  value: string
  label: string
}

export type EditableChangeRequest = {
  id: string
  payload: Record<string, unknown>
}

const KINDS: ChangeRequestKind[] = ['hire', 'status_change', 'assignment_change', 'termination']

const HIRE_STATUSES = ['offered', 'active', 'on_leave', 'suspended'] as const
const ALL_STATUSES = ['offered', 'active', 'on_leave', 'suspended', 'terminated'] as const

function todayCivil(): string {
  return new Date().toISOString().slice(0, 10)
}

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
  const editing = initialRequest !== null
  const initialPayload = (initialRequest?.payload ?? {}) as Record<string, unknown>

  const [kind, setKind] = useState<ChangeRequestKind>(
    initialPayload.kind === 'status_change' ||
      initialPayload.kind === 'assignment_change' ||
      initialPayload.kind === 'termination'
      ? initialPayload.kind
      : 'hire',
  )
  const [status, setStatus] = useState(asText(initialPayload.status) || 'active')
  const [effectiveFrom, setEffectiveFrom] = useState(asText(initialPayload.effectiveFrom) || todayCivil())
  const [effectiveTo, setEffectiveTo] = useState(asText(initialPayload.effectiveTo))
  const [effectiveDate, setEffectiveDate] = useState(asText(initialPayload.effectiveDate) || todayCivil())
  const [assignmentKey, setAssignmentKey] = useState(asText(initialPayload.assignmentKey))
  const [jobTitle, setJobTitle] = useState(asText(initialPayload.jobTitle))
  const [departmentId, setDepartmentId] = useState(asText(initialPayload.departmentId))
  const [locationId, setLocationId] = useState(asText(initialPayload.locationId))
  const [fte, setFte] = useState(asText(initialPayload.fte))
  const [primary, setPrimary] = useState(
    initialPayload.isPrimary === true ? 'yes' : initialPayload.isPrimary === false ? 'no' : 'unchanged',
  )
  const [managerEmploymentId, setManagerEmploymentId] = useState(asText(initialPayload.managerEmploymentId))
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const kindLabel = (value: ChangeRequestKind): string =>
    value === 'hire'
      ? t('employment.changeRequests.kindHire')
      : value === 'status_change'
        ? t('employment.changeRequests.kindStatusChange')
        : value === 'assignment_change'
          ? t('employment.changeRequests.kindAssignmentChange')
          : t('employment.changeRequests.kindTermination')

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
    return {
      kind,
      assignmentKey: assignmentKey.trim(),
      ...(jobTitle.trim() ? { jobTitle: jobTitle.trim() } : {}),
      ...(departmentId ? { departmentId } : {}),
      ...(locationId.trim() ? { locationId: locationId.trim() } : {}),
      ...(fte.trim() ? { fte: fte.trim() } : {}),
      ...(primary === 'unchanged' ? {} : { isPrimary: primary === 'yes' }),
      ...(effectiveFrom.trim() ? { effectiveFrom: effectiveFrom.trim() } : {}),
      ...(effectiveTo.trim() ? { effectiveTo: effectiveTo.trim() } : {}),
      ...(managerEmploymentId.trim() ? { managerEmploymentId: managerEmploymentId.trim() } : {}),
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
    const res = await fetch(`/api/hrm/change-requests/${requestId}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: submitReason }),
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
    if (kind === 'assignment_change' && !assignmentKey.trim()) {
      setError(t('employment.changeRequests.assignmentKeyRequired'))
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
              <Input
                id="cr-location"
                value={locationId}
                disabled={busy}
                onChange={(event) => setLocationId(event.target.value)}
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
              <Input
                id="cr-manager"
                value={managerEmploymentId}
                disabled={busy}
                onChange={(event) => setManagerEmploymentId(event.target.value)}
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

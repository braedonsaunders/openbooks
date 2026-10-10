'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button, Drawer, Label, SearchSelect, Select, Textarea } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../lib/api-error'
import { useDirtyClose } from '../../../lib/use-dirty-close'
import { useBusinessToday } from '../../../components/business-date-provider'

/**
 * The first-employment Hire action. Opens from an employee record with no
 * employment (fixed person) and from the change-request queue in hire mode
 * (person picker over the hireable-people options). Records person +
 * employing legal entity + effective start through the native
 * POST /api/hrm/employments hire — the same change-request service every
 * later episode rides: a configured approval flow decides it, and a flow
 * with the apply-without-approval outcome applies it at once. res.ok is
 * checked before any body is parsed; refusals toast and render inline
 * with their remedy intact.
 */

type PickerOption = {
  value: string
  label: string
}

const HIRE_STATUSES = ['offered', 'active', 'on_leave', 'suspended'] as const

export function HireEmploymentDrawer({
  partyId,
  partyName,
  onClose,
  onSaved,
}: {
  /** Fixed when opened from the employee record; omitted for the queue's person picker. */
  partyId?: string
  partyName?: string
  onClose: () => void
  onSaved: () => void
}) {
  const t = useTranslations('hrm')
  const tCommon = useTranslations('common')
  const router = useRouter()
  // A new hire defaults to the org's business day from the server, never
  // the browser's UTC day (tomorrow after 5pm Pacific).
  const today = useBusinessToday()
  const [personId, setPersonId] = useState(partyId ?? '')
  const [personOptions, setPersonOptions] = useState<PickerOption[]>([])
  const [personQuery, setPersonQuery] = useState('')
  const [personLoading, setPersonLoading] = useState(!partyId)
  const [personStatus, setPersonStatus] = useState<string | undefined>(undefined)
  const [employerId, setEmployerId] = useState('')
  const [employerOptions, setEmployerOptions] = useState<PickerOption[]>([])
  const [employerQuery, setEmployerQuery] = useState('')
  const [employerLoading, setEmployerLoading] = useState(true)
  const [employerStatus, setEmployerStatus] = useState<string | undefined>(undefined)
  const [status, setStatus] = useState('active')
  const [effectiveFrom, setEffectiveFrom] = useState(today)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const personRequestId = useRef(0)
  const employerRequestId = useRef(0)
  const employerPreselected = useRef(false)

  // Remote per-query people picker over source=hireable-people: bounded
  // page per query so people beyond the first page stay selectable. A
  // sequence guard drops stale responses.
  useEffect(() => {
    if (partyId) return
    const id = (personRequestId.current += 1)
    const params = new URLSearchParams()
    params.set('source', 'hireable-people')
    params.set('limit', '25')
    if (personQuery.trim()) params.set('q', personQuery.trim())
    if (personId) params.set('include', personId)
    fetch(`/api/hrm/options?${params.toString()}`, { method: 'GET' })
      .then(async (res) => {
        if (id !== personRequestId.current) return
        if (!res.ok) {
          setPersonStatus(await readApiErrorMessage(res, t('employment.hire.personFailed')))
          setPersonLoading(false)
          return
        }
        const payload = (await res.json().catch(() => ({}))) as {
          options?: { partyId?: unknown; label?: unknown }[]
        }
        if (id !== personRequestId.current) return
        const page = Array.isArray(payload.options) ? payload.options : []
        const merged: PickerOption[] = []
        for (const row of page) {
          if (typeof row.partyId === 'string' && typeof row.label === 'string') {
            merged.push({ value: row.partyId, label: row.label })
          }
        }
        if (personId && !merged.some((option) => option.value === personId)) {
          merged.push({ value: personId, label: personId })
        }
        setPersonOptions(merged)
        setPersonStatus(undefined)
        setPersonLoading(false)
      })
      .catch(() => {
        if (id !== personRequestId.current) return
        setPersonStatus(t('employment.hire.personFailed'))
        setPersonLoading(false)
      })
  }, [partyId, personQuery, personId, t])

  // The legal-entity picker over source=employer-subsidiaries: same
  // bounded-page, sequence-guarded composition. A single visible entity
  // preselects — a fresh single-entity company hires without choosing.
  useEffect(() => {
    const id = (employerRequestId.current += 1)
    const params = new URLSearchParams()
    params.set('source', 'employer-subsidiaries')
    params.set('limit', '25')
    if (employerQuery.trim()) params.set('q', employerQuery.trim())
    if (employerId) params.set('include', employerId)
    fetch(`/api/hrm/options?${params.toString()}`, { method: 'GET' })
      .then(async (res) => {
        if (id !== employerRequestId.current) return
        if (!res.ok) {
          setEmployerStatus(await readApiErrorMessage(res, t('employment.hire.employerFailed')))
          setEmployerLoading(false)
          return
        }
        const payload = (await res.json().catch(() => ({}))) as {
          options?: { subsidiaryId?: unknown; label?: unknown }[]
        }
        if (id !== employerRequestId.current) return
        const page = Array.isArray(payload.options) ? payload.options : []
        const merged: PickerOption[] = []
        for (const row of page) {
          if (typeof row.subsidiaryId === 'string' && typeof row.label === 'string') {
            merged.push({ value: row.subsidiaryId, label: row.label })
          }
        }
        if (employerId && !merged.some((option) => option.value === employerId)) {
          merged.push({ value: employerId, label: employerId })
        }
        setEmployerOptions(merged)
        setEmployerStatus(undefined)
        setEmployerLoading(false)
        if (!employerPreselected.current && !employerId && !employerQuery.trim() && merged.length === 1 && merged[0]) {
          employerPreselected.current = true
          setEmployerId(merged[0].value)
        }
      })
      .catch(() => {
        if (id !== employerRequestId.current) return
        setEmployerStatus(t('employment.hire.employerFailed'))
        setEmployerLoading(false)
      })
  }, [employerQuery, employerId, t])

  const dirty = personId !== (partyId ?? '') || employerId !== '' || status !== 'active' || effectiveFrom !== today || reason !== ''
  const closeGuard = useDirtyClose({
    dirty,
    busy,
    onClose,
    message: tCommon('feedback.unsavedChanges'),
    confirmLabel: tCommon('confirm.discardChanges'),
  })

  const statusLabel = (value: string): string =>
    t.has(`employment.status.${value}`) ? t(`employment.status.${value}`) : value

  function requirePerson(): boolean {
    if (!personId) {
      setError(t('employment.hire.personRequired'))
      return false
    }
    return true
  }

  function requireEmployer(): boolean {
    if (!employerId) {
      setError(t('employment.hire.employerRequired'))
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

  async function submitHire() {
    if (!requirePerson()) return
    if (!requireEmployer()) return
    const hireReason = requireReason()
    if (hireReason === null) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/hrm/employments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workerPartyId: personId,
          employerSubsidiaryId: employerId,
          status,
          effectiveFrom,
          reason: hireReason,
        }),
      })
      if (!res.ok) {
        const message = await readApiErrorMessage(res, t('employment.changeRequests.requestFailed'))
        setError(message)
        toast.error(message)
        return
      }
      const data = (await res.json().catch(() => ({}))) as {
        employment?: { id?: unknown }
        request?: { id?: unknown; status?: unknown }
        applied?: unknown
      }
      if (typeof data.employment?.id !== 'string' || typeof data.request?.id !== 'string') {
        const message = t('employment.changeRequests.requestFailed')
        setError(message)
        toast.error(message)
        return
      }
      toast.success(
        t(data.applied === true ? 'employment.changeRequests.appliedToast' : 'employment.changeRequests.submittedToast'),
      )
      onClose()
      onSaved()
      router.refresh()
    } catch {
      const message = t('employment.changeRequests.requestFailed')
      setError(message)
      toast.error(message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Drawer
      open
      onClose={() => void closeGuard.close()}
      size="md"
      title={t('employment.hire.title')}
      description={t('employment.hire.description')}
      headerActions={
        <>
          <Button variant="outline" disabled={busy} onClick={() => void closeGuard.close()}>
            {tCommon('actions.cancel')}
          </Button>
          <Button disabled={busy} onClick={submitHire}>
            {t('employment.hire.submit')}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {partyId ? (
          <div className="space-y-1.5">
            <Label>{t('employment.hire.personLabel')}</Label>
            <p className="text-sm text-slate-900 dark:text-slate-100">{partyName ?? partyId}</p>
          </div>
        ) : (
          <div className="space-y-1.5">
            <Label htmlFor="hire-person">{t('employment.hire.personLabel')}</Label>
            <SearchSelect
              id="hire-person"
              value={personId}
              onChange={(next) => {
                setPersonId(next)
                setError(null)
              }}
              options={personOptions}
              ariaLabel={t('employment.hire.personLabel')}
              sheetTitle={t('employment.hire.personLabel')}
              emptyLabel={t('employment.hire.personPlaceholder')}
              remote
              loading={personLoading}
              statusMessage={personStatus ?? (personOptions.length === 0 && !personLoading ? t('employment.hire.personEmpty') : undefined)}
              statusTone={personStatus ? 'error' : 'muted'}
              onSearchChange={(next) => {
                setPersonQuery(next)
                setPersonLoading(true)
                setPersonStatus(undefined)
              }}
              disabled={busy}
            />
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="hire-employer">{t('employment.hire.employerLabel')}</Label>
          <SearchSelect
            id="hire-employer"
            value={employerId}
            onChange={(next) => {
              setEmployerId(next)
              setError(null)
            }}
            options={employerOptions}
            ariaLabel={t('employment.hire.employerLabel')}
            sheetTitle={t('employment.hire.employerLabel')}
            emptyLabel={t('employment.hire.employerPlaceholder')}
            remote
            loading={employerLoading}
            statusMessage={employerStatus}
            statusTone={employerStatus ? 'error' : 'muted'}
            onSearchChange={(next) => {
              setEmployerQuery(next)
              setEmployerLoading(true)
              setEmployerStatus(undefined)
            }}
            disabled={busy}
          />
          <p className="text-xs text-slate-500 dark:text-slate-400">{t('employment.hire.employerHint')}</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="hire-status">{t('employment.hire.statusLabel')}</Label>
          <Select id="hire-status" value={status} disabled={busy} onChange={(event) => setStatus(event.target.value)}>
            {HIRE_STATUSES.map((option) => (
              <option key={option} value={option}>
                {statusLabel(option)}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="hire-effective-from">{t('employment.hire.startLabel')}</Label>
          <input
            id="hire-effective-from"
            type="date"
            value={effectiveFrom}
            disabled={busy}
            required
            onChange={(event) => event.target.value && setEffectiveFrom(event.target.value)}
            className="w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="hire-reason">{t('employment.changeRequests.reasonLabel')}</Label>
          <Textarea
            id="hire-reason"
            value={reason}
            disabled={busy}
            required
            onChange={(event) => setReason(event.target.value)}
          />
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

'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button, Drawer, Input, Label, Select, Textarea } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../../lib/api-error'
import { promptDialog } from '../../../../lib/prompt'
import { useAppAction } from '../../../../lib/use-app-action'
import { useDirtyClose } from '../../../../lib/use-dirty-close'
import { ActionError } from '@braedonsaunders/appkit-errors'

/**
 * Leave filing and detail drawer. Opens blank for filing (employment, type,
 * range, hours, reason) — or, for actors holding manageable employments, in
 * a manager on-behalf mode naming the target employee and posting
 * onBehalf — or on a request id for detail: the request with its
 * TIME balance and, where a payroll bank exists, its VALUE balances — each
 * labelled with its unit so the two are never conflated.
 *
 * Withdraw and cancel run here against the leave API routes with their
 * refusals; submit opens the approval run. Approval outcomes stay in native
 * Approvals (the drawer deep-links the run): the governed decision path is
 * never duplicated. Every API refusal renders with its message intact —
 * res.ok is checked before parsing, failures render inline, and nothing is
 * swallowed.
 */

interface Detail {
  request: {
    id: string
    employmentId: string
    leaveTypeCode: string
    startsOn: string
    endsOn: string
    hours: string
    reason: string | null
    status: string
    decidedBy: string | null
    decisionReason: string | null
  }
  timeBalance: { kind: 'time'; policyId: string | null; earned: string | null; carried: string; taken: string; balance: string | null; unlimited: boolean } | null
  valueBalances: { kind: 'value'; planCode: string; planName: string; balance: string }[]
  asOf: string
}

export function LeaveDrawer({
  requestId,
  canWithdrawCancel,
  onClose,
}: {
  requestId: string | null
  /** Holds hrm.leave.request (mirrors the withdraw/cancel route guard). */
  canWithdrawCancel: boolean
  onClose: () => void
}) {
  const t = useTranslations('hrm')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const [detail, setDetail] = useState<Detail | null>(null)
  const [loading, setLoading] = useState(requestId !== null)
  const [status, setStatus] = useState<string | undefined>(undefined)
  const [filingDirty, setFilingDirty] = useState(false)
  const [filingBusy, setFilingBusy] = useState(false)
  const filingClose = useDirtyClose({
    dirty: filingDirty,
    busy: filingBusy,
    onClose,
    message: tCommon('feedback.unsavedChanges'),
    confirmLabel: tCommon('confirm.discardChanges'),
  })

  useEffect(() => {
    if (!requestId) return
    let live = true
    fetch(`/api/hrm/leave-requests/${requestId}`, { method: 'GET' })
      .then(async (res) => {
        if (!live) return
        if (!res.ok) {
          setStatus(await readApiErrorMessage(res, t('leave.detailFailed')))
          setLoading(false)
          return
        }
        setDetail((await res.json().catch(() => null)) as Detail | null)
        setStatus(undefined)
        setLoading(false)
      })
      .catch(() => {
        if (!live) return
        setStatus(t('leave.detailFailed'))
        setLoading(false)
      })
    return () => {
      live = false
    }
  }, [requestId, t])

  const runAction = async (action: 'submit' | 'withdraw' | 'cancel', reason?: string): Promise<void> => {
    if (!requestId) return
    const res = await fetch(`/api/hrm/leave-requests/${requestId}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(action === 'submit' ? {} : { reason }),
    })
    if (!res.ok) {
      setStatus(await readApiErrorMessage(res, t('leave.actionFailed')))
      return
    }
    router.refresh()
    onClose()
  }

  // An empty reason never posts: the routes refuse it (reason required),
  // so posting it would only turn a dismissed prompt into a 400.
  const askReason = async (title: string): Promise<string | null> => {
    const reason = await promptDialog({ title, label: title })
    if (reason !== null && reason.trim().length === 0) return null
    return reason
  }

  return (
    <Drawer open onClose={() => void filingClose.close()} size="md" title={requestId ? t('leave.drawerTitle') : t('leave.fileTitle')}>
      {loading ? <p className="text-sm text-slate-500">{t('leave.detailLoading')}</p> : null}
      {status ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {status}
        </p>
      ) : null}
      {!loading && requestId && detail ? (
        <div className="space-y-4">
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <dt className="text-slate-500">{t('leave.columns.type')}</dt>
            <dd className="font-medium">{detail.request.leaveTypeCode}</dd>
            <dt className="text-slate-500">{t('leave.columns.range')}</dt>
            <dd className="tabular-nums">
              {detail.request.startsOn} → {detail.request.endsOn}
            </dd>
            <dt className="text-slate-500">{t('leave.columns.hours')}</dt>
            <dd className="tabular-nums">{detail.request.hours}</dd>
            <dt className="text-slate-500">{t('leave.columns.status')}</dt>
            <dd>{t.has(`leave.statusNames.${detail.request.status}`) ? t(`leave.statusNames.${detail.request.status}`) : detail.request.status}</dd>
          </dl>
          {detail.request.reason ? <p className="text-sm text-slate-600">{detail.request.reason}</p> : null}
          <div className="rounded-lg bg-slate-50 p-3 text-sm dark:bg-slate-800">
            <p className="font-semibold">{t('leave.timeBalanceTitle', { date: detail.asOf })}</p>
            {detail.timeBalance?.unlimited ? (
              <p>{t('leave.unlimitedBalance')}</p>
            ) : detail.timeBalance?.balance !== null && detail.timeBalance ? (
              <p className="tabular-nums">
                {t('leave.timeBalanceValue', {
                  balance: detail.timeBalance.balance ?? '',
                  earned: detail.timeBalance.earned ?? '',
                  carried: detail.timeBalance.carried,
                  taken: detail.timeBalance.taken,
                })}
              </p>
            ) : (
              <p>{t('leave.noPolicyBalance')}</p>
            )}
          </div>
          {detail.valueBalances.length > 0 ? (
            <div className="rounded-lg bg-slate-50 p-3 text-sm dark:bg-slate-800">
              <p className="font-semibold">{t('leave.valueBalanceTitle', { date: detail.asOf })}</p>
              <ul>
                {detail.valueBalances.map((bank) => (
                  <li key={bank.planCode} className="tabular-nums">
                    {bank.planName}: {bank.balance}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {detail.request.decisionReason ? (
            <p className="text-sm text-slate-600">{detail.request.decisionReason}</p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {detail.request.status === 'draft' ? (
              <Button size="sm" onClick={() => void runAction('submit')}>
                {t('leave.submitButton')}
              </Button>
            ) : null}
            {canWithdrawCancel && (detail.request.status === 'draft' || detail.request.status === 'submitted') ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void askReason(t('leave.withdrawReasonTitle')).then((reason) => {
                    if (reason !== null) void runAction('withdraw', reason)
                  })
                }
              >
                {t('leave.withdrawButton')}
              </Button>
            ) : null}
            {canWithdrawCancel && detail.request.status === 'approved' ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void askReason(t('leave.cancelReasonTitle')).then((reason) => {
                    if (reason !== null) void runAction('cancel', reason)
                  })
                }
              >
                {t('leave.cancelButton')}
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" onClick={onClose}>
              {tCommon('actions.close')}
            </Button>
          </div>
        </div>
      ) : null}
      {!loading && !requestId ? (
        <LeaveFileForm
          onCancel={filingClose.close}
          onSaved={onClose}
          onDirtyChange={setFilingDirty}
          onBusyChange={setFilingBusy}
        />
      ) : null}
    </Drawer>
  )
}

function LeaveFileForm({
  onCancel,
  onSaved,
  onDirtyChange,
  onBusyChange,
}: {
  onCancel: () => void | Promise<void>
  onSaved: () => void
  onDirtyChange: (dirty: boolean) => void
  onBusyChange: (busy: boolean) => void
}) {
  const t = useTranslations('hrm')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const [employmentId, setEmploymentId] = useState('')
  const [leaveTypeId, setLeaveTypeId] = useState('')
  const [typeOptions, setTypeOptions] = useState<{ value: string; label: string }[]>([])
  const [startsOn, setStartsOn] = useState('')
  const [endsOn, setEndsOn] = useState('')
  const [hours, setHours] = useState('')
  const [reason, setReason] = useState('')
  const [status, setStatus] = useState<string | undefined>(undefined)
  const { busy: saving, execute } = useAppAction()
  // Manager on-behalf filing: the employments the actor may manage leave
  // for, listed through the same grant-plus-scope predicate the filing gate
  // enforces. A self-service actor holds none, so the mode never renders
  // for them — the capability probe, not a redefined permission check,
  // decides.
  const [filingFor, setFilingFor] = useState<'self' | 'onBehalf'>('self')
  const [manageOptions, setManageOptions] = useState<{ value: string; label: string }[]>([])
  const [manageLoaded, setManageLoaded] = useState(false)
  const [onBehalfEmploymentId, setOnBehalfEmploymentId] = useState('')
  // Self-service employments: the actor's own employments behind the
  // request grant — the same ownership the filing gate enforces — so the
  // picker can never offer an employment the filing refusal would reject.
  const [ownOptions, setOwnOptions] = useState<{ value: string; label: string }[]>([])
  const [ownLoaded, setOwnLoaded] = useState(false)
  const canFileOnBehalf = manageOptions.length > 0
  const onBehalf = manageLoaded && canFileOnBehalf && filingFor === 'onBehalf'

  // Leave-type options ride the HRM options route with its refusals; the
  // drawer submits ids, never labels.
  useEffect(() => {
    let live = true
    fetch('/api/hrm/options?source=leave-types&limit=200', { method: 'GET' })
      .then(async (res) => {
        if (!live) return
        if (!res.ok) {
          setStatus(await readApiErrorMessage(res, t('leave.fileFailed')))
          return
        }
        const payload = (await res.json().catch(() => ({}))) as {
          options?: { id?: unknown; label?: unknown }[]
        }
        if (!live) return
        const page = Array.isArray(payload.options) ? payload.options : []
        setTypeOptions(
          page.flatMap((row) =>
            typeof row.id === 'string' && typeof row.label === 'string'
              ? [{ value: row.id, label: row.label }]
              : [],
          ),
        )
      })
      .catch(() => {
        if (live) setStatus(t('leave.fileFailed'))
      })
    return () => {
      live = false
    }
  }, [t])

  // On-behalf employments ride the same options route behind the manage
  // grant. A 403/404 is not an error here — it is the self-service shape:
  // the actor holds no manage grant, so the mode stays hidden silently.
  // Anything else failing surfaces, so a manager is never stranded on a
  // silently empty picker.
  useEffect(() => {
    let live = true
    fetch('/api/hrm/options?source=leave-filing-employments&limit=100', { method: 'GET' })
      .then(async (res) => {
        if (!live) return
        if (!res.ok) {
          if (res.status !== 403 && res.status !== 404) {
            setStatus(await readApiErrorMessage(res, t('leave.fileFailed')))
          }
          setManageLoaded(true)
          return
        }
        const payload = (await res.json().catch(() => ({}))) as {
          options?: { id?: unknown; label?: unknown }[]
        }
        if (!live) return
        const page = Array.isArray(payload.options) ? payload.options : []
        setManageOptions(
          page.flatMap((row) =>
            typeof row.id === 'string' && typeof row.label === 'string'
              ? [{ value: row.id, label: row.label }]
              : [],
          ),
        )
        setManageLoaded(true)
      })
      .catch(() => {
        if (live) setManageLoaded(true)
      })
    return () => {
      live = false
    }
  }, [t])

  // The actor's own employments ride the same options route behind the
  // request grant. A refusal surfaces with its message intact — it names
  // the missing grant, which is the remedy.
  useEffect(() => {
    let live = true
    fetch('/api/hrm/options?source=leave-own-employments&limit=100', { method: 'GET' })
      .then(async (res) => {
        if (!live) return
        if (!res.ok) {
          setStatus(await readApiErrorMessage(res, t('leave.fileFailed')))
          setOwnLoaded(true)
          return
        }
        const payload = (await res.json().catch(() => ({}))) as {
          options?: { id?: unknown; label?: unknown }[]
        }
        if (!live) return
        const page = Array.isArray(payload.options) ? payload.options : []
        const list = page.flatMap((row) =>
          typeof row.id === 'string' && typeof row.label === 'string'
            ? [{ value: row.id, label: row.label }]
            : [],
        )
        setOwnOptions(list)
        // A single employment files without a choice: preselect it so the
        // common case never meets the required-field refusal.
        if (list.length === 1 && list[0]) setEmploymentId(list[0].value)
        setOwnLoaded(true)
      })
      .catch(() => {
        if (live) {
          setStatus(t('leave.fileFailed'))
          setOwnLoaded(true)
        }
      })
    return () => {
      live = false
    }
  }, [t])

  const save = async (): Promise<void> => {
    if (onBehalf && !onBehalfEmploymentId) {
      setStatus(t('leave.onBehalfEmploymentRequired'))
      return
    }
    if (!onBehalf && !employmentId) {
      setStatus(t('leave.fileEmploymentRequired'))
      return
    }
    setStatus(undefined)
    onBusyChange(true)
    try {
      await execute(async () => {
      try {
        const res = await fetch('/api/hrm/leave-requests', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: onBehalf
            ? JSON.stringify({
                employmentId: onBehalfEmploymentId,
                leaveTypeId,
                startsOn,
                endsOn,
                hours,
                reason: reason || null,
                onBehalf: true,
              })
            : JSON.stringify({ employmentId, leaveTypeId, startsOn, endsOn, hours, reason: reason || null }),
        })
        if (!res.ok) {
          setStatus(await readApiErrorMessage(res, t('leave.fileFailed')))
          return { ok: true as const, status: res.status, data: null }
        }
        router.refresh()
        onDirtyChange(false)
        onSaved()
        return { ok: true as const, status: res.status, data: null }
      } catch {
        return {
          ok: false as const,
          error: new ActionError({ kind: 'transport', serverMessage: t('leave.fileFailed') }),
        }
      }
      }, {
        fallbackMessage: t('leave.fileFailed'),
        onRefused: (error) => setStatus(error.displayMessage(t('leave.fileFailed'))),
      })
    } finally {
      onBusyChange(false)
    }
  }

  function markDirty<T>(update: (value: T) => void, value: T) {
    update(value)
    onDirtyChange(true)
  }

  return (
    <div className="space-y-3">
      {manageLoaded && canFileOnBehalf ? (
        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">{t('leave.onBehalfFilingForLabel')}</legend>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="leave-filing-for"
              className="accent-teal-700"
              checked={filingFor === 'self'}
              onChange={() => markDirty(setFilingFor, 'self')}
            />
            {t('leave.onBehalfSelfLabel')}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="leave-filing-for"
              className="accent-teal-700"
              checked={filingFor === 'onBehalf'}
              onChange={() => markDirty(setFilingFor, 'onBehalf')}
            />
            {t('leave.onBehalfOtherLabel')}
          </label>
          <p className="text-xs text-slate-500">{t('leave.onBehalfHint')}</p>
        </fieldset>
      ) : null}
      {onBehalf ? (
        <div>
          <Label htmlFor="leave-onbehalf-employment">{t('leave.onBehalfEmployeeLabel')}</Label>
          <Select
            id="leave-onbehalf-employment"
            value={onBehalfEmploymentId}
            onChange={(event) => markDirty(setOnBehalfEmploymentId, event.target.value)}
          >
            <option value="">{t('leave.onBehalfEmployeePlaceholder')}</option>
            {manageOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>
      ) : ownLoaded && ownOptions.length === 0 ? (
        <p className="text-sm text-slate-500">{t('leave.fileNoEmployment')}</p>
      ) : (
        <div>
          <Label htmlFor="leave-employment">{t('leave.fileEmploymentLabel')}</Label>
          <Select
            id="leave-employment"
            value={employmentId}
            onChange={(event) => markDirty(setEmploymentId, event.target.value)}
          >
            <option value="">{t('leave.fileEmploymentPlaceholder')}</option>
            {ownOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>
      )}
      <div>
        <Label htmlFor="leave-type">{t('leave.fileTypeLabel')}</Label>
        <Select id="leave-type" value={leaveTypeId} onChange={(event) => markDirty(setLeaveTypeId, event.target.value)}>
          <option value="">{t('leave.fileTypePlaceholder')}</option>
          {typeOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label htmlFor="leave-starts">{t('leave.calendarFromLabel')}</Label>
            <Input id="leave-starts" type="date" value={startsOn} onChange={(event) => markDirty(setStartsOn, event.target.value)} />
        </div>
        <div>
          <Label htmlFor="leave-ends">{t('leave.calendarToLabel')}</Label>
            <Input id="leave-ends" type="date" value={endsOn} onChange={(event) => markDirty(setEndsOn, event.target.value)} />
        </div>
      </div>
      <div>
        <Label htmlFor="leave-hours">{t('leave.fileHoursLabel')}</Label>
          <Input id="leave-hours" inputMode="decimal" value={hours} onChange={(event) => markDirty(setHours, event.target.value)} placeholder="8" />
      </div>
      <div>
        <Label htmlFor="leave-reason">{t('leave.fileReasonLabel')}</Label>
          <Textarea id="leave-reason" value={reason} onChange={(event) => markDirty(setReason, event.target.value)} />
      </div>
      {status ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {status}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => void onCancel()}>
          {tCommon('actions.cancel')}
        </Button>
        <Button size="sm" disabled={saving} onClick={() => void save()}>
          {t('leave.fileButton')}
        </Button>
      </div>
    </div>
  )
}

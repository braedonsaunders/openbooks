'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { Button, Label, Select } from '@openbooks/ui'
import { useTranslations } from 'next-intl'
import { readApiErrorMessage } from '../../../../../lib/api-error'

/**
 * Inline attestation controls for statutory-holiday exceptions (migrations
 * 0181, 0409). The calculation refuses BY NAME wherever a declaring rule's
 * fact is missing — commission-pay status, employment class, the
 * last-and-first-shift absence assertion — and no fact is inferable from a
 * timesheet, so the refusal is correct and the remedy is an explicit answer
 * filed HERE, on the row that names what is missing.
 *
 * Two different kinds of fact, two different homes:
 * - commission status and employment class are STANDING employment
 *   attributes: answering either on the exception row writes the employee's
 *   payroll profile once, and later periods stop asking.
 * - the absence assertion is PER (run, holiday): answering it files a row
 *   scoped to this run and this holiday occurrence, so a later period never
 *   inherits it.
 *
 * Every select defaults to UNANSWERED. The common answer ("no, not absent";
 * "no, not on commission") is one explicit choice away, but the control
 * never answers for the operator: filing only happens on Save, and the
 * engine keeps requiring the value to be present.
 *
 * Copy is catalog-backed so the refusal remedy is usable in every supported
 * viewer locale.
 */

export interface AttestationError {
  employee: string
  message: string
  /** Post-0182 structured fields, preferred when present. */
  employeePartyId?: string
  holidayKey?: string
  holidayDate?: string
  neededFact?: 'paidOnCommission' | 'absentWithoutConsent' | 'entitledDayAssessment' | 'occupationClass'
}

interface OccupationClassOption {
  classKey: string
  label: string
  citation: string
}

interface DemandingHoliday {
  key: string
  date: string
  name: string
  needsCommissionStatus: boolean
  needsAbsenceAssertion: boolean
  needsEntitlementDayAssessment: boolean
  needsOccupationClass: boolean
  evidencedDayCount?: number
  attestedDayCount?: number
}

interface AttestationEmployee {
  employeePartyId: string
  name: string
  paidOnCommission: boolean | null
  occupationClass: string | null
  occupationClasses: OccupationClassOption[]
  assertions: { holidayKey: string; holidayDate: string; absentWithoutConsent: boolean }[]
  demanding: DemandingHoliday[]
}

type NeededFact = 'paidOnCommission' | 'absentWithoutConsent' | 'entitledDayAssessment' | 'occupationClass' | null

function classifyError(error: AttestationError): NeededFact {
  if (error.neededFact === 'paidOnCommission' || error.neededFact === 'absentWithoutConsent'
      || error.neededFact === 'entitledDayAssessment' || error.neededFact === 'occupationClass') {
    return error.neededFact
  }
  if (/commission-pay status/.test(error.message)) return 'paidOnCommission'
  if (/occupation class is not recorded/.test(error.message)) return 'occupationClass'
  if (/last-and-first-shift/.test(error.message)) return 'absentWithoutConsent'
  if (/entitlement-day evidence is complete/.test(error.message)) return 'entitledDayAssessment'
  return null
}

export function HolidayAttestations(props: {
  runId: string
  errors: AttestationError[]
  roster: { employee_party_id: string; name: string }[]
  canAnswer: boolean
  /** Re-run the calculation after an answer is filed (server merges stored facts). */
  onAnswered: () => Promise<void> | void
}) {
  const t = useTranslations('payroll.holidayAttestations')
  const { runId, errors, roster, canAnswer, onAnswered } = props
  const [employees, setEmployees] = useState<AttestationEmployee[] | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState(false)

  const actionable = errors
    .map((error, index) => ({ error, index, needed: classifyError(error) }))
    .filter((item) => item.needed !== null)
  // An ambiguous name match files nothing: the control stays hidden rather
  // than answering for the wrong employee.
  const resolveEmployee = (error: AttestationError): AttestationEmployee | null => {
    if (error.employeePartyId) {
      return employees?.find((entry) => entry.employeePartyId === error.employeePartyId) ?? null
    }
    const matches = roster.filter((row) => row.name === error.employee)
    if (matches.length !== 1) return null
    return employees?.find((entry) => entry.employeePartyId === matches[0]!.employee_party_id) ?? null
  }

  useEffect(() => {
    if (!canAnswer || actionable.length === 0) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/payroll/runs/${runId}/holiday-assertions`)
        // The status is checked before the body is parsed: a non-JSON error
        // body must surface the failure, never a SyntaxError from res.json().
        if (!res.ok) throw new Error(await readApiErrorMessage(res, 'failed'))
        const j = await res.json()
        if (!cancelled) {
          setEmployees(Array.isArray(j.employees) ? j.employees : [])
          setLoadFailed(false)
        }
      } catch {
        if (!cancelled) setLoadFailed(true)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, canAnswer, attempt])

  if (!canAnswer || actionable.length === 0) return null
  // A failed employee lookup must read as a failure with a retry — never as
  // the empty panel, which is what "no exceptions need answers" looks like.
  if (loadFailed) {
    return (
      <div className="mt-3 space-y-2 border-t border-amber-200/60 pt-3 dark:border-amber-800/40">
        <p className="text-sm text-red-700 dark:text-red-300">
          {t('loadFailed')}
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setLoadFailed(false)
            setAttempt((n) => n + 1)
          }}
        >
          {t('retry')}
        </Button>
      </div>
    )
  }
  if (employees === null) return null

  async function file(body: Record<string, unknown>) {
    setBusy(true)
    try {
      const res = await fetch(`/api/payroll/runs/${runId}/holiday-assertions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      // The status is checked before the body is parsed (see load above).
      if (!res.ok) throw new Error(await readApiErrorMessage(res, 'failed'))
      // Refresh standing answers + filed assertions so the row shows what
      // was just answered, then recalculate through the server-side merge.
      // A failed refresh is a failure, not a silent skip: the success toast
      // below must never follow a refresh the operator never saw.
      const reload = await fetch(`/api/payroll/runs/${runId}/holiday-assertions`)
      if (!reload.ok) throw new Error(await readApiErrorMessage(reload, 'failed'))
      const rj = await reload.json()
      if (Array.isArray(rj.employees)) setEmployees(rj.employees)
      toast.success(t('answerFiled'))
      await onAnswered()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-3 space-y-3 border-t border-amber-200/60 pt-3 dark:border-amber-800/40">
      {actionable.map(({ error, index, needed }) => {
        const attested = resolveEmployee(error)
        if (!attested) return null
        return (
          <AttestationRow
            key={index}
            error={error}
            needed={needed!}
            attested={attested}
            busy={busy}
            onFile={file}
          />
        )
      })}
    </div>
  )
}

function AttestationRow(props: {
  error: AttestationError
  needed: Exclude<NeededFact, null>
  attested: AttestationEmployee
  busy: boolean
  onFile: (body: Record<string, unknown>) => Promise<void>
}) {
  const t = useTranslations('payroll.holidayAttestations')
  const { error, needed, attested, busy, onFile } = props
  const [commission, setCommission] = useState('')
  const [employment, setEmployment] = useState('')
  const [absence, setAbsence] = useState<Record<string, string>>({})
  const [complete, setComplete] = useState<Record<string, string>>({})
  // Pack-declared English reads as written where no locale key exists — the
  // same arrangement the profile editor uses for pack data.
  const classLabel = (classKey: string, fallback: string): string => {
    const key = `employmentClassOptions.${classKey}`
    try {
      return t.has(key as never) ? (t(key as never) as unknown as string) : fallback
    } catch {
      return fallback
    }
  }

  if (needed === 'paidOnCommission') {
    const standing = attested.paidOnCommission
    return (
      <div className="rounded-lg bg-white/70 px-3 py-2.5 dark:bg-slate-900/60">
        <p className="text-sm font-medium text-slate-800 dark:text-slate-100">
          {error.employee}: {t('commissionTitle')}
        </p>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          {standing === null
            ? t('standingUnanswered')
            : t('currentlyAnswered', { answer: t(standing ? 'yesWholePart' : 'no') })}
        </p>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <div>
            <Label htmlFor={`att-comm-${attested.employeePartyId}`}>{t('paidOnCommission')}</Label>
            <Select
              id={`att-comm-${attested.employeePartyId}`}
              value={commission}
              onChange={(e) => setCommission(e.target.value)}
            >
              <option value="">{t('choose')}</option>
              <option value="false">{t('no')}</option>
              <option value="true">{t('yesWholePart')}</option>
            </Select>
          </div>
          <Button
            size="sm"
            disabled={busy || commission === ''}
            onClick={() => void onFile({
              employeePartyId: attested.employeePartyId,
              paidOnCommission: commission === 'true',
            })}
          >
            {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null}
            {t('saveRecalculate')}
          </Button>
        </div>
      </div>
    )
  }

  if (needed === 'occupationClass') {
    const standing = attested.occupationClass
    const options = attested.occupationClasses ?? []
    // A stored answer the jurisdiction no longer offers stays answerable:
    // hiding the control would strand it with no way to clear it.
    const offered = standing && !options.some((option) => option.classKey === standing)
      ? [...options, { classKey: standing, label: standing, citation: '' }]
      : options
    if (offered.length === 0) return null
    return (
      <div className="rounded-lg bg-white/70 px-3 py-2.5 dark:bg-slate-900/60">
        <p className="text-sm font-medium text-slate-800 dark:text-slate-100">
          {error.employee}: {t('employmentClassTitle')}
        </p>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          {standing === null
            ? t('standingUnanswered')
            : t('currentlyAnswered', { answer: classLabel(standing, standing) })}
        </p>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <div>
            <Label htmlFor={`att-empclass-${attested.employeePartyId}`}>{t('employmentClass')}</Label>
            <Select
              id={`att-empclass-${attested.employeePartyId}`}
              value={employment}
              onChange={(e) => setEmployment(e.target.value)}
            >
              <option value="">{t('choose')}</option>
              {offered.map((option) => (
                <option key={option.classKey} value={option.classKey} title={option.citation}>
                  {classLabel(option.classKey, option.label)}
                </option>
              ))}
            </Select>
          </div>
          <Button
            size="sm"
            disabled={busy || employment === ''}
            onClick={() => void onFile({
              employeePartyId: attested.employeePartyId,
              occupationClass: employment,
            })}
          >
            {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null}
            {t('saveRecalculate')}
          </Button>
        </div>
      </div>
    )
  }

  if (needed === 'entitledDayAssessment') {
    const holidays = attested.demanding.filter((holiday) => holiday.needsEntitlementDayAssessment)
    const explicit = error.holidayKey && error.holidayDate
      ? holidays.filter((holiday) => holiday.key === error.holidayKey && holiday.date === error.holidayDate)
      : holidays
    if (explicit.length === 0) return null
    return (
      <div className="rounded-lg bg-white/70 px-3 py-2.5 dark:bg-slate-900/60">
        <p className="text-sm font-medium text-slate-800 dark:text-slate-100">
          {error.employee}: {t('entitlementTitle')}
        </p>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          {t('entitlementExplanation')}
        </p>
        {explicit.map((holiday) => {
          const occurrence = `${holiday.key}|${holiday.date}`
          return (
            <div key={occurrence} className="mt-2 flex flex-wrap items-end gap-2">
              <div>
                <Label htmlFor={`att-ent-${attested.employeePartyId}-${occurrence}`}>
                  {t('holidayDate', { holiday: holiday.name, date: holiday.date })}: {' '}
                  {t('entitlementCount', { count: holiday.evidencedDayCount ?? 0 })}
                  {holiday.attestedDayCount !== undefined
                    ? ` ${t('entitlementFiled', { count: holiday.attestedDayCount })}` : ''}
                </Label>
                <Select
                  id={`att-ent-${attested.employeePartyId}-${occurrence}`}
                  value={complete[occurrence] ?? ''}
                  onChange={(e) => setComplete((prev) => ({ ...prev, [occurrence]: e.target.value }))}
                >
                  <option value="">{t('choose')}</option>
                  <option value="true">{t('entitlementConfirm')}</option>
                </Select>
              </div>
              <Button
                size="sm"
                disabled={busy || holiday.evidencedDayCount === undefined || complete[occurrence] !== 'true'}
                onClick={() => void onFile({
                  employeePartyId: attested.employeePartyId,
                  holidayKey: holiday.key, holidayDate: holiday.date,
                  entitlementEvidenceComplete: true,
                })}
              >
                {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null}
                {t('saveRecalculate')}
              </Button>
            </div>
          )
        })}
      </div>
    )
  }

  const holidays = attested.demanding.filter((holiday) => holiday.needsAbsenceAssertion)
  // The structured post-0182 error names its own occurrence; otherwise the
  // run's demanding occurrences are the candidates (usually exactly one).
  const explicit = error.holidayKey && error.holidayDate
    ? holidays.filter((holiday) => holiday.key === error.holidayKey && holiday.date === error.holidayDate)
    : holidays
  if (explicit.length === 0) return null
  return (
    <div className="rounded-lg bg-white/70 px-3 py-2.5 dark:bg-slate-900/60">
      <p className="text-sm font-medium text-slate-800 dark:text-slate-100">
        {error.employee}: {t('absenceTitle')}
      </p>
      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
        {t('absenceExplanation')}
      </p>
      {explicit.map((holiday) => {
        const occurrence = `${holiday.key}|${holiday.date}`
        const filed = attested.assertions.find(
          (entry) => entry.holidayKey === holiday.key && entry.holidayDate === holiday.date,
        )
        return (
          <div key={occurrence} className="mt-2 flex flex-wrap items-end gap-2">
            <div>
              <Label htmlFor={`att-abs-${attested.employeePartyId}-${occurrence}`}>
                {t('holidayDate', { holiday: holiday.name, date: holiday.date })}
                {filed !== undefined ? ` ${t('filedStatus', { answer: t(filed.absentWithoutConsent ? 'absentWithoutConsent' : 'notAbsent') })}` : ''}
              </Label>
              <Select
                id={`att-abs-${attested.employeePartyId}-${occurrence}`}
                value={absence[occurrence] ?? ''}
                onChange={(e) => setAbsence((prev) => ({ ...prev, [occurrence]: e.target.value }))}
              >
                <option value="">{t('choose')}</option>
                <option value="false">{t('absenceNo')}</option>
                <option value="true">{t('absenceYes')}</option>
              </Select>
            </div>
            <Button
              size="sm"
              disabled={busy || (absence[occurrence] ?? '') === ''}
              onClick={() => void onFile({
                employeePartyId: attested.employeePartyId,
                holidayKey: holiday.key,
                holidayDate: holiday.date,
                absentWithoutConsent: absence[occurrence] === 'true',
              })}
            >
              {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null}
              {t('saveRecalculate')}
            </Button>
          </div>
        )
      })}
    </div>
  )
}

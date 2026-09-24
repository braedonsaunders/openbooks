'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { Button, Label, Select } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../../../lib/api-error'

/**
 * Inline attestation controls for statutory-holiday exceptions (migration
 * 0181). The calculation refuses BY NAME wherever a declaring rule's fact is
 * missing — commission-pay status, the last-and-first-shift absence
 * assertion — and neither fact is inferable from a timesheet, so the refusal
 * is correct and the remedy is an explicit answer filed HERE, on the row
 * that names what is missing.
 *
 * Two different kinds of fact, two different homes:
 * - commission status is a STANDING employment attribute: answering it on
 *   the exception row writes the employee's payroll profile once, and later
 *   periods stop asking.
 * - the absence assertion is PER (run, holiday): answering it files a row
 *   scoped to this run and this holiday occurrence, so a later period never
 *   inherits it.
 *
 * Every select defaults to UNANSWERED. The common answer ("no, not absent";
 * "no, not on commission") is one explicit choice away, but the control
 * never answers for the operator: filing only happens on Save, and the
 * engine keeps requiring the value to be present.
 *
 * Copy is literal English, deliberately: the payroll locale files are owned
 * by the live hsf-translations shard, and a refusal-remedy control must not
 * wait on it. Localize later without touching this file.
 */

export interface AttestationError {
  employee: string
  message: string
  /** Post-0182 structured fields, preferred when present. */
  employeePartyId?: string
  holidayKey?: string
  holidayDate?: string
  neededFact?: 'paidOnCommission' | 'absentWithoutConsent'
}

interface DemandingHoliday {
  key: string
  date: string
  name: string
  needsCommissionStatus: boolean
  needsAbsenceAssertion: boolean
}

interface AttestationEmployee {
  employeePartyId: string
  name: string
  paidOnCommission: boolean | null
  assertions: { holidayKey: string; holidayDate: string; absentWithoutConsent: boolean }[]
  demanding: DemandingHoliday[]
}

type NeededFact = 'paidOnCommission' | 'absentWithoutConsent' | null

function classifyError(error: AttestationError): NeededFact {
  if (error.neededFact === 'paidOnCommission' || error.neededFact === 'absentWithoutConsent') {
    return error.neededFact
  }
  if (/commission-pay status/.test(error.message)) return 'paidOnCommission'
  if (/last-and-first-shift/.test(error.message)) return 'absentWithoutConsent'
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
          Could not load the employees these exceptions need — retry rather than answer blind.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setLoadFailed(false)
            setAttempt((n) => n + 1)
          }}
        >
          Retry
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
      toast.success('Answer filed — recalculating')
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
  const { error, needed, attested, busy, onFile } = props
  const [commission, setCommission] = useState('')
  const [absence, setAbsence] = useState<Record<string, string>>({})

  if (needed === 'paidOnCommission') {
    const standing = attested.paidOnCommission
    return (
      <div className="rounded-lg bg-white/70 px-3 py-2.5 dark:bg-slate-900/60">
        <p className="text-sm font-medium text-slate-800 dark:text-slate-100">
          {error.employee}: commission-pay status
        </p>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          {standing === null
            ? 'Unanswered. This is a standing employment fact — answer it once and later periods stop asking.'
            : `Currently answered: ${standing ? 'yes, in whole or in part' : 'no'}. Re-answer to correct it.`}
        </p>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <div>
            <Label htmlFor={`att-comm-${attested.employeePartyId}`}>Paid on commission</Label>
            <Select
              id={`att-comm-${attested.employeePartyId}`}
              value={commission}
              onChange={(e) => setCommission(e.target.value)}
            >
              <option value="">Choose…</option>
              <option value="false">No</option>
              <option value="true">Yes, in whole or in part</option>
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
            Save &amp; recalculate
          </Button>
        </div>
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
        {error.employee}: last-and-first-shift absence assertion
      </p>
      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
        Was the employee absent WITHOUT the employer&apos;s consent on the last scheduled shift before
        or the first after the holiday? A timesheet gap cannot answer this — an absence in the data
        is as likely to be approved leave. This answer is filed for this run only.
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
                {holiday.name} · {holiday.date}
                {filed !== undefined ? ` (filed: ${filed.absentWithoutConsent ? 'absent without consent' : 'not absent'})` : ''}
              </Label>
              <Select
                id={`att-abs-${attested.employeePartyId}-${occurrence}`}
                value={absence[occurrence] ?? ''}
                onChange={(e) => setAbsence((prev) => ({ ...prev, [occurrence]: e.target.value }))}
              >
                <option value="">Choose…</option>
                <option value="false">No — not absent without consent</option>
                <option value="true">Yes — absent without consent</option>
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
              Save &amp; recalculate
            </Button>
          </div>
        )
      })}
    </div>
  )
}

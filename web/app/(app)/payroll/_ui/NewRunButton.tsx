'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Play, Plus } from 'lucide-react'
import { Button, Drawer, Label, Select } from '@openbooks/ui'

export interface FinalPayCandidate {
  id: string
  name: string
  pay_schedule_id: string
  terminated_on: string
}

export interface RunSchedule {
  id: string
  name: string
  frequency: string
  pay_date_offset_days: number
  /** Last period end on this schedule (or its anchor when nothing has run). */
  last_end: string | null
}

const DAY = 86_400_000
const iso = (d: Date) => d.toISOString().slice(0, 10)
const at = (value: string) => new Date(`${value}T00:00:00Z`)

/** Period length in days for the schedule's cadence (month-ends handled below). */
function addPeriod(from: Date, frequency: string): Date {
  const next = new Date(from)
  switch (frequency) {
    case 'weekly': next.setUTCDate(next.getUTCDate() + 7); break
    case 'biweekly': next.setUTCDate(next.getUTCDate() + 14); break
    case 'semimonthly': next.setUTCDate(next.getUTCDate() + 15); break
    case 'monthly': next.setUTCMonth(next.getUTCMonth() + 1); break
    default: next.setUTCDate(next.getUTCDate() + 14)
  }
  return next
}

/** The schedule's next period: the day after its last period end, one cadence long. */
function nextPeriod(schedule: RunSchedule, today: string): { start: string; end: string; payDate: string } {
  const lastEnd = at(schedule.last_end ?? today)
  const start = new Date(lastEnd.getTime() + DAY)
  const end = new Date(addPeriod(start, schedule.frequency).getTime() - DAY)
  const payDate = new Date(end.getTime() + (schedule.pay_date_offset_days ?? 0) * DAY)
  return { start: iso(start), end: iso(end), payDate: iso(payDate) }
}

async function postRun(body: Record<string, unknown>): Promise<string> {
  const res = await fetch('/api/payroll/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const j = await res.json()
  if (!res.ok) throw new Error(j.error ?? 'failed')
  return j.documentId as string
}

/** One-click run for a known schedule, using its derived next period. */
export function StartRunButton({ payScheduleId, size = 'sm' }: { payScheduleId: string; size?: 'sm' | 'md' }) {
  const t = useTranslations('payroll')
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  return (
    <Button
      size={size}
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        try {
          router.push(`/payroll/runs/${await postRun({ payScheduleId })}`)
        } catch (e) {
          toast.error((e as Error).message)
          setBusy(false)
        }
      }}
    >
      <Play size={14} aria-hidden /> {t('home.actions.startRun')}
    </Button>
  )
}

/**
 * New pay run: choose the schedule and confirm the period the run covers.
 * The schedule's next period prefills every field; off-cycle and catch-up runs
 * change the dates here. The server independently validates the window
 * (no overlap with an existing run, no far-future period).
 */
export function NewRunButton({
  schedules,
  finalPayCandidates = [],
  today,
}: {
  schedules: RunSchedule[]
  /** Employees whose employment has ended — the only final-pay scope. */
  finalPayCandidates?: FinalPayCandidate[]
  /** Org business day — never the browser's UTC date. */
  today: string
}) {
  const t = useTranslations('payroll')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [scheduleId, setScheduleId] = useState(schedules[0]?.id ?? '')
  const [runType, setRunType] = useState<'regular' | 'bonus' | 'termination'>('regular')
  const [paidEmployees, setPaidEmployees] = useState<string[]>([])
  const schedule = schedules.find((s) => s.id === scheduleId) ?? schedules[0]
  const derived = schedule ? nextPeriod(schedule, today) : { start: '', end: '', payDate: '' }
  const [period, setPeriod] = useState(derived)
  const [touched, setTouched] = useState(false)

  // Switching schedules re-prefills until the operator edits a date.
  const shown = touched ? period : derived

  function selectSchedule(id: string) {
    setScheduleId(id)
    setTouched(false)
    // The scope belongs to the schedule that was chosen with it.
    setPaidEmployees([])
    const next = schedules.find((s) => s.id === id)
    if (next) setPeriod(nextPeriod(next, today))
  }

  function setField(key: 'start' | 'end' | 'payDate', value: string) {
    setTouched(true)
    setPeriod({ ...shown, [key]: value })
  }

  const scopeCandidates = finalPayCandidates.filter((e) => e.pay_schedule_id === scheduleId)

  async function create() {
    if (!scheduleId) return
    setBusy(true)
    try {
      const documentId = await postRun({
        payScheduleId: scheduleId,
        periodStart: shown.start,
        periodEnd: shown.end,
        payDate: shown.payDate,
        runType,
        employeePartyIds: runType === 'termination' ? paidEmployees : [],
      })
      setOpen(false)
      router.push(`/payroll/runs/${documentId}`)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // Mirrors the server guards so the dialog never proposes a rejected window.
  const badWindow = !shown.start || !shown.end || !shown.payDate
    || shown.end < shown.start || shown.payDate < shown.end
  const notBegun = !!shown.start && shown.start > today
  // A final pay run without a named scope would pay and drain the whole
  // schedule; the engine refuses one, so the dialog never proposes one either.
  const unscopedFinalPay = runType === 'termination' && paidEmployees.length === 0
  const invalid = !scheduleId || badWindow || notBegun || unscopedFinalPay

  if (schedules.length === 0) return null
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus size={14} aria-hidden /> {t('newRun.create')}
      </Button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title={t('newRun.create')}
        description={t('newRun.description')}
        size="sm"
        footer={
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>{tCommon('actions.cancel')}</Button>
            <Button onClick={create} disabled={busy || invalid}>
              {busy ? tCommon('actions.saving') : t('newRun.create')}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="run-type" help={t(`newRun.runTypeHint.${runType}`)}>{t('newRun.runType')}</Label>
            <Select
              id="run-type"
              value={runType}
              onChange={(e) => setRunType(e.target.value as typeof runType)}
            >
              <option value="regular">{t('runType.regular')}</option>
              <option value="bonus">{t('runType.bonus')}</option>
              <option value="termination">{t('runType.termination')}</option>
            </Select>
          </div>
          {schedules.length > 1 && (
            <div className="space-y-1.5">
              <Label htmlFor="run-schedule">{t('columns.schedule')}</Label>
              <Select id="run-schedule" value={scheduleId} onChange={(e) => selectSchedule(e.target.value)}>
                {schedules.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </Select>
            </div>
          )}
          {runType === 'termination' && (
            <div className="space-y-1.5">
              <Label help={t('newRun.employeesHint')}>{t('newRun.employees')}</Label>
              {scopeCandidates.length === 0 ? (
                <p className="text-xs text-slate-500 dark:text-slate-400">{t('newRun.noTerminated')}</p>
              ) : (
                <>
                  <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-slate-200 p-2 dark:border-slate-700">
                    {scopeCandidates.map((employee) => (
                      <label key={employee.id} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={paidEmployees.includes(employee.id)}
                          onChange={(e) => setPaidEmployees((current) => (
                            e.target.checked
                              ? [...current, employee.id]
                              : current.filter((id) => id !== employee.id)
                          ))}
                        />
                        <span>{employee.name}</span>
                        <span className="text-xs text-slate-500 dark:text-slate-400">
                          {employee.terminated_on}
                        </span>
                      </label>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="run-start">{t('newRun.periodStart')}</Label>
              <input
                id="run-start" type="date" value={shown.start}
                onChange={(e) => setField('start', e.target.value)}
                className="h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-950"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="run-end">{t('newRun.periodEnd')}</Label>
              <input
                id="run-end" type="date" value={shown.end}
                onChange={(e) => setField('end', e.target.value)}
                className="h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-950"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="run-paydate" help={t('newRun.payDateHint')}>{t('columns.payDate')}</Label>
            <input
              id="run-paydate" type="date" value={shown.payDate}
              onChange={(e) => setField('payDate', e.target.value)}
              className="h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-950"
            />
          </div>
          {badWindow && (shown.start || shown.end) ? (
            <p className="text-sm text-red-600 dark:text-red-400">{t('newRun.invalidWindow')}</p>
          ) : notBegun ? (
            <p className="text-sm text-amber-600 dark:text-amber-400">
              {t('newRun.notBegun', { date: shown.start })}
            </p>
          ) : null}
        </div>
      </Drawer>
    </>
  )
}

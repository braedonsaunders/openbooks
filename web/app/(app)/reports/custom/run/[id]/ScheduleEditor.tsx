'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslations } from 'next-intl'
import { Badge, Button, Input, Label, Select } from '@openbooks/ui'
import { describeCadence, REPORT_CADENCES, type ReportCadence } from '@openbooks/reports'
import { confirmDialog } from '@/lib/confirm'

export type ScheduleRow = {
  id: string
  definition_id: string
  cadence: string
  day_of_week: number | null
  day_of_month: number | null
  hour: number
  minute: number
  timezone: string
  recipient_emails: string[]
  next_run_at: string
  active: boolean
}

// Message keys under reports.schedule.weekdays, indexed by day-of-week number.
const WEEKDAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const

// Message keys under reports.schedule.cadences — unknown cadence codes render verbatim.
const CADENCE_KEY: Record<string, string> = {
  daily: 'cadences.daily',
  weekly: 'cadences.weekly',
  monthly: 'cadences.monthly',
}

function describe(s: ScheduleRow): string {
  return describeCadence({
    cadence: s.cadence as ReportCadence,
    dayOfWeek: s.day_of_week,
    dayOfMonth: s.day_of_month,
    hour: s.hour,
    minute: s.minute,
    timezone: s.timezone,
  })
}

export function ScheduleEditor({
  definitionId,
  schedules,
  canSchedule,
}: {
  definitionId: string
  schedules: ScheduleRow[]
  canSchedule: boolean
}) {
  const t = useTranslations('reports.schedule')
  const tc = useTranslations('common')
  const router = useRouter()
  const [adding, setAdding] = useState(false)

  async function toggleActive(s: ScheduleRow) {
    const res = await fetch(`/api/reports/schedules/${s.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: !s.active }),
    })
    if (!res.ok) toast.error((await res.json()).error ?? t('updateFailed'))
    else toast.success(s.active ? t('paused') : t('resumed'))
    router.refresh()
  }

  async function remove(s: ScheduleRow) {
    const ok = await confirmDialog({ message: t('deleteConfirm'), tone: 'danger' })
    if (!ok) return
    const res = await fetch(`/api/reports/schedules/${s.id}`, { method: 'DELETE' })
    if (!res.ok) toast.error((await res.json()).error ?? tc('feedback.deleteFailed'))
    else toast.success(t('deleted'))
    router.refresh()
  }

  return (
    <div className="space-y-3">
      {schedules.length === 0 && !adding ? (
        <div className="rounded-lg border border-dashed border-slate-300 px-4 py-6 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
          {t('noScheduleYet')} {canSchedule ? t('addOneHint') : ''}
        </div>
      ) : null}

      {schedules.map((s) => (
        <div
          key={s.id}
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 px-4 py-3 dark:border-slate-800"
        >
          <div className="min-w-0 space-y-0.5">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-slate-800 dark:text-slate-100">
                {describe(s)}
              </span>
              <Badge variant={s.active ? 'success' : 'secondary'}>
                {s.active ? tc('status.active') : t('pausedBadge')}
              </Badge>
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400">
              {s.recipient_emails.length > 0
                ? t('recipientsTo', { emails: s.recipient_emails.join(', ') })
                : t('noRecipients')}
              {' · '}
              {t('nextRun', { time: String(s.next_run_at).slice(0, 16).replace('T', ' ') })}
            </div>
          </div>
          {canSchedule ? (
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => toggleActive(s)}>
                {s.active ? t('pause') : t('resume')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => remove(s)} aria-label={t('deleteAria')}>
                <Trash2 size={14} />
              </Button>
            </div>
          ) : null}
        </div>
      ))}

      {canSchedule ? (
        adding ? (
          <ScheduleForm
            definitionId={definitionId}
            onDone={() => {
              setAdding(false)
              router.refresh()
            }}
            onCancel={() => setAdding(false)}
          />
        ) : (
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            <Plus size={14} /> {t('addSchedule')}
          </Button>
        )
      ) : null}
    </div>
  )
}

const GUESSED_TZ = typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC'

function ScheduleForm({
  definitionId,
  onDone,
  onCancel,
}: {
  definitionId: string
  onDone: () => void
  onCancel: () => void
}) {
  const t = useTranslations('reports.schedule')
  const tc = useTranslations('common')
  const [cadence, setCadence] = useState<ReportCadence>('weekly')
  const [dayOfWeek, setDayOfWeek] = useState(1)
  const [dayOfMonth, setDayOfMonth] = useState(1)
  const [hour, setHour] = useState(7)
  const [minute, setMinute] = useState(0)
  const [timezone, setTimezone] = useState(GUESSED_TZ || 'UTC')
  const [recipients, setRecipients] = useState('')
  const [busy, setBusy] = useState(false)

  async function save() {
    setBusy(true)
    const res = await fetch('/api/reports/schedules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        definitionId,
        cadence,
        dayOfWeek,
        dayOfMonth,
        hour,
        minute,
        timezone,
        recipientEmails: recipients
          .split(/[,\n]/)
          .map((s) => s.trim())
          .filter(Boolean),
      }),
    })
    if (!res.ok) {
      toast.error((await res.json()).error ?? t('saveFailed'))
      setBusy(false)
      return
    }
    toast.success(t('saved'))
    setBusy(false)
    onDone()
  }

  const field = 'space-y-1.5'
  return (
    <div className="space-y-4 rounded-lg border border-slate-200 p-4 dark:border-slate-800">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className={field}>
          <Label>{t('cadence')}</Label>
          <Select value={cadence} onChange={(e) => setCadence(e.target.value as ReportCadence)}>
            {REPORT_CADENCES.map((c) => (
              <option key={c} value={c}>
                {CADENCE_KEY[c] ? t(CADENCE_KEY[c]) : c}
              </option>
            ))}
          </Select>
        </div>
        {cadence === 'weekly' ? (
          <div className={field}>
            <Label>{t('dayOfWeek')}</Label>
            <Select value={String(dayOfWeek)} onChange={(e) => setDayOfWeek(Number(e.target.value))}>
              {WEEKDAY_KEYS.map((d, i) => (
                <option key={i} value={i}>
                  {t(`weekdays.${d}`)}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        {cadence === 'monthly' ? (
          <div className={field}>
            <Label>{t('dayOfMonth')}</Label>
            <Input
              type="number"
              min={1}
              max={31}
              value={dayOfMonth}
              onChange={(e) => setDayOfMonth(Math.min(Math.max(Number(e.target.value) || 1, 1), 31))}
            />
          </div>
        ) : null}
        <div className={field}>
          <Label>{t('time')}</Label>
          <Input
            type="time"
            value={`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`}
            onChange={(e) => {
              const [h, m] = e.target.value.split(':')
              setHour(Number(h) || 0)
              setMinute(Number(m) || 0)
            }}
          />
        </div>
        <div className={field}>
          <Label>{t('timezone')}</Label>
          <Input value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="America/Toronto" />
        </div>
      </div>
      <div className={field}>
        <Label>{t('recipients')}</Label>
        <Input
          value={recipients}
          onChange={(e) => setRecipients(e.target.value)}
          placeholder={t('recipientsPlaceholder')}
        />
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {t('recipientsHint')}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={busy} onClick={save}>
          {busy ? tc('actions.saving') : t('saveSchedule')}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {tc('actions.cancel')}
        </Button>
      </div>
    </div>
  )
}

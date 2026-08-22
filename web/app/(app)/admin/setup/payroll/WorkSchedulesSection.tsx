'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import {
  Badge,
  Button,
  Drawer,
  FieldLabel,
  Input,
  Label,
  SearchSelect,
  Select,
} from '@openbooks/ui'
import { useBusinessToday } from '../../../../../components/business-date-provider'
import { PagedTable } from '../../../../../components/paged-table'

/**
 * Work schedules — the hours and days an employee is normally scheduled to
 * work, edited as REAL CONTROLS.
 *
 * The pattern is a repeating cycle of days (engine/src/work-schedules.ts), and
 * the one thing this editor must never become is a JSON box: a working week is
 * a grid of numbers a payroll administrator reads at a glance, and the numbers
 * decide a day's statutory holiday pay in several jurisdictions. So the cycle
 * renders as one labelled hour input per position — Sunday…Saturday for the
 * ordinary week, "Week 1 / Week 2" for a fortnight, "Day 1…n" for a rotation
 * that does not line up with the week at all.
 *
 * Help text goes in the EXISTING `?` popover (FieldLabel / Label help=), never
 * a second tooltip system.
 */

interface ScheduleDay { dayIndex: number; hours: string }

interface Schedule {
  id: string
  name: string | null
  employeePartyId: string | null
  jobTitle: string | null
  tradeId: string | null
  departmentId: string | null
  subsidiaryId: string | null
  pattern: 'cycle' | 'varies'
  cycleDays: number | null
  cycleAnchor: string | null
  days: ScheduleDay[]
  effectiveFrom: string
  effectiveTo: string | null
  isActive: boolean
}

interface Options {
  employees: { id: string; name: string }[]
  trades: { id: string; name: string }[]
  departments: { id: string; name: string }[]
  subsidiaries: { id: string; name: string }[]
}

type ScopeKind = 'organization' | 'employee' | 'jobTitle' | 'trade' | 'department' | 'subsidiary'

const WEEKDAY_KEYS = [
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
] as const

/** The most specific scope a row carries — the same order the engine resolves
 *  in, so what the screen says and what the pay run does cannot diverge. */
function scopeOf(schedule: Schedule): ScopeKind {
  if (schedule.employeePartyId) return 'employee'
  if (schedule.jobTitle) return 'jobTitle'
  if (schedule.tradeId) return 'trade'
  if (schedule.departmentId) return 'department'
  if (schedule.subsidiaryId) return 'subsidiary'
  return 'organization'
}

const decimal = (value: string) =>
  value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value

const sumHours = (days: ScheduleDay[]) =>
  days.reduce((total, day) => total + (Number(day.hours) || 0), 0)

const blank = (today: string): Schedule => ({
  id: '',
  name: null,
  employeePartyId: null,
  jobTitle: null,
  tradeId: null,
  departmentId: null,
  subsidiaryId: null,
  pattern: 'cycle',
  cycleDays: 7,
  // A Sunday, so a seven-day cycle's positions ARE the weekdays and the grid
  // can be labelled Sunday…Saturday.
  cycleAnchor: '2024-01-07',
  days: [1, 2, 3, 4, 5].map((dayIndex) => ({ dayIndex, hours: '8' })),
  effectiveFrom: today,
  effectiveTo: null,
  isActive: true,
})

export function WorkSchedulesSection({ canManage }: { canManage: boolean }) {
  const t = useTranslations('payroll.workSchedules')
  const tc = useTranslations('common')
  const today = useBusinessToday()
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [options, setOptions] = useState<Options>({
    employees: [], trades: [], departments: [], subsidiaries: [],
  })
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState<Schedule | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/work-schedules')
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'failed')
      setSchedules(json.schedules ?? [])
      setOptions(json.options ?? { employees: [], trades: [], departments: [], subsidiaries: [] })
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const nameFor = useCallback((schedule: Schedule) => {
    const scope = scopeOf(schedule)
    if (scope === 'employee') {
      return options.employees.find((e) => e.id === schedule.employeePartyId)?.name
        ?? schedule.employeePartyId!
    }
    if (scope === 'jobTitle') return schedule.jobTitle!
    if (scope === 'trade') return options.trades.find((x) => x.id === schedule.tradeId)?.name ?? ''
    if (scope === 'department') {
      return options.departments.find((x) => x.id === schedule.departmentId)?.name ?? ''
    }
    if (scope === 'subsidiary') {
      return options.subsidiaries.find((x) => x.id === schedule.subsidiaryId)?.name ?? ''
    }
    return t('scope.organization')
  }, [options, t])

  const columns = useMemo(() => [
    {
      key: 'scope',
      header: t('columns.appliesTo'),
      cell: (row: Schedule) => (
        <div className="min-w-0">
          <div className="truncate font-medium">{nameFor(row)}</div>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            {t(`scope.${scopeOf(row)}` as never)}
            {row.name ? ` · ${row.name}` : ''}
          </div>
        </div>
      ),
      search: (row: Schedule) => `${nameFor(row)} ${row.name ?? ''}`,
    },
    {
      key: 'pattern',
      header: t('columns.pattern'),
      cell: (row: Schedule) => (
        row.pattern === 'varies'
          ? <Badge variant="outline">{t('pattern.varies')}</Badge>
          : <span>{t('summary.cycle', {
              hours: decimal(sumHours(row.days).toFixed(4)),
              days: row.days.length,
              cycle: row.cycleDays === 7
                ? t('summary.week')
                : t('summary.cycleDays', { count: row.cycleDays ?? 0 }),
            })}</span>
      ),
    },
    {
      key: 'from',
      header: t('columns.effectiveFrom'),
      cell: (row: Schedule) => (
        <span className="tabular-nums">
          {row.effectiveFrom}{row.effectiveTo ? ` → ${row.effectiveTo}` : ''}
        </span>
      ),
    },
    {
      key: 'active',
      header: t('columns.status'),
      cell: (row: Schedule) => (
        row.isActive
          ? <Badge variant="outline">{tc('status.active')}</Badge>
          : <Badge variant="secondary">{tc('status.inactive')}</Badge>
      ),
    },
  ], [nameFor, t, tc])

  async function save() {
    if (!draft) return
    setBusy(true)
    try {
      const res = await fetch('/api/work-schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'save', ...draft, id: draft.id || undefined }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'failed')
      toast.success(tc('feedback.saved'))
      setDraft(null)
      await load()
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string) {
    setBusy(true)
    try {
      const res = await fetch('/api/work-schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', id }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'failed')
      setDraft(null)
      await load()
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {t('title')}
          </h3>
          <p className="max-w-3xl text-sm text-slate-500 dark:text-slate-400">
            {t('description')}
          </p>
        </div>
        {canManage ? (
          <Button onClick={() => setDraft(blank(today))}>{t('add')}</Button>
        ) : null}
      </header>

      <PagedTable
        rows={schedules}
        columns={columns}
        searchable
        rowKey={(row) => row.id}
        empty={loading ? tc('feedback.loading') : t('empty')}
        onRowClick={canManage ? (row) => setDraft({ ...row, days: [...row.days] }) : undefined}
      />

      <Drawer
        open={draft !== null}
        onClose={() => setDraft(null)}
        size="lg"
        title={draft?.id ? t('editTitle') : t('add')}
        description={t('drawerDescription')}
        footer={draft ? (
          <div className="flex items-center justify-between gap-2">
            {draft.id ? (
              <Button variant="ghost" disabled={busy} onClick={() => void remove(draft.id)}>
                {tc('actions.delete')}
              </Button>
            ) : <span />}
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setDraft(null)}>
                {tc('actions.cancel')}
              </Button>
              <Button disabled={busy} onClick={() => void save()}>{tc('actions.save')}</Button>
            </div>
          </div>
        ) : null}
      >
        {draft ? (
          <ScheduleForm
            draft={draft}
            options={options}
            onChange={setDraft}
          />
        ) : null}
      </Drawer>
    </section>
  )
}

function ScheduleForm({
  draft,
  options,
  onChange,
}: {
  draft: Schedule
  options: Options
  onChange: (next: Schedule) => void
}) {
  const t = useTranslations('payroll.workSchedules')
  const today = useBusinessToday()
  const scope = scopeOf(draft)
  const patch = (next: Partial<Schedule>) => onChange({ ...draft, ...next })

  /** Switching scope clears every other key: exactly one may be set, and the
   *  engine's resolution order depends on that being true. */
  const setScope = (kind: ScopeKind) => patch({
    employeePartyId: null, jobTitle: null, tradeId: null, departmentId: null, subsidiaryId: null,
    ...(kind === 'jobTitle' ? { jobTitle: '' } : {}),
  })

  const hoursAt = (dayIndex: number) =>
    draft.days.find((day) => day.dayIndex === dayIndex)?.hours ?? ''

  const setHours = (dayIndex: number, value: string) => {
    const rest = draft.days.filter((day) => day.dayIndex !== dayIndex)
    const next = value.trim() === '' || Number(value) === 0
      ? rest
      : [...rest, { dayIndex, hours: value }]
    patch({ days: next.sort((a, b) => a.dayIndex - b.dayIndex) })
  }

  const cycleDays = draft.cycleDays ?? 7
  /** Sunday…Saturday when the cycle is a whole number of weeks anchored on a
   *  Sunday; otherwise the honest "Day n", because a rotation genuinely has no
   *  weekday. */
  const anchorIsSunday = draft.cycleAnchor
    ? new Date(`${draft.cycleAnchor}T00:00:00Z`).getUTCDay() === 0
    : false
  const weekAligned = anchorIsSunday && cycleDays % 7 === 0

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <FieldLabel fieldName="workScheduleName">{t('fields.name')}</FieldLabel>
          <Input
            value={draft.name ?? ''}
            placeholder={t('fields.namePlaceholder')}
            onChange={(event) => patch({ name: event.target.value })}
          />
        </div>
        <div>
          <Label help={t('help.scope')}>{t('fields.appliesTo')}</Label>
          <Select
            value={scope}
            onChange={(event) => setScope(event.target.value as ScopeKind)}
          >
            <option value="organization">{t('scope.organization')}</option>
            <option value="employee">{t('scope.employee')}</option>
            <option value="jobTitle">{t('scope.jobTitle')}</option>
            <option value="trade">{t('scope.trade')}</option>
            <option value="department">{t('scope.department')}</option>
            <option value="subsidiary">{t('scope.subsidiary')}</option>
          </Select>
        </div>
      </div>

      {scope === 'employee' ? (
        <div>
          <FieldLabel fieldName="workScheduleEmployee">{t('scope.employee')}</FieldLabel>
          <SearchSelect
            options={options.employees.map((e) => ({ value: e.id, label: e.name }))}
            value={draft.employeePartyId ?? ''}
            onChange={(value) => patch({ employeePartyId: value ?? null })}
            placeholder={t('fields.selectEmployee')}
          />
        </div>
      ) : null}
      {scope === 'jobTitle' ? (
        <div>
          <FieldLabel fieldName="workScheduleJobTitle">{t('scope.jobTitle')}</FieldLabel>
          <Input
            value={draft.jobTitle ?? ''}
            onChange={(event) => patch({ jobTitle: event.target.value })}
          />
        </div>
      ) : null}
      {scope === 'trade' || scope === 'department' || scope === 'subsidiary' ? (
        <div>
          <FieldLabel fieldName="workScheduleScopeRef">{t(`scope.${scope}` as never)}</FieldLabel>
          <SearchSelect
            options={(scope === 'trade' ? options.trades
              : scope === 'department' ? options.departments
              : options.subsidiaries).map((x) => ({ value: x.id, label: x.name }))}
            value={(scope === 'trade' ? draft.tradeId
              : scope === 'department' ? draft.departmentId
              : draft.subsidiaryId) ?? ''}
            onChange={(value) => patch(
              scope === 'trade' ? { tradeId: value ?? null }
              : scope === 'department' ? { departmentId: value ?? null }
              : { subsidiaryId: value ?? null },
            )}
            placeholder={t('fields.selectScope')}
          />
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label help={t('help.effectiveFrom')}>{t('fields.effectiveFrom')}</Label>
          <Input
            type="date"
            value={draft.effectiveFrom}
            onChange={(event) => patch({ effectiveFrom: event.target.value })}
          />
        </div>
        <div>
          <FieldLabel fieldName="workScheduleEffectiveTo">{t('fields.effectiveTo')}</FieldLabel>
          <Input
            type="date"
            value={draft.effectiveTo ?? ''}
            onChange={(event) => patch({ effectiveTo: event.target.value || null })}
          />
        </div>
      </div>

      <fieldset className="space-y-2">
        <Label help={t('help.pattern')}>{t('fields.pattern')}</Label>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            className="mt-1"
            checked={draft.pattern === 'cycle'}
            onChange={() => patch({
              pattern: 'cycle',
              cycleDays: draft.cycleDays ?? 7,
              cycleAnchor: draft.cycleAnchor ?? blank(today).cycleAnchor,
              days: draft.days.length ? draft.days : blank(today).days,
            })}
          />
          <span>
            <span className="font-medium">{t('pattern.cycle')}</span>
            <span className="block text-slate-500 dark:text-slate-400">
              {t('pattern.cycleHint')}
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            className="mt-1"
            checked={draft.pattern === 'varies'}
            onChange={() => patch({
              pattern: 'varies', cycleDays: null, cycleAnchor: null, days: [],
            })}
          />
          <span>
            <span className="font-medium">{t('pattern.varies')}</span>
            <span className="block text-slate-500 dark:text-slate-400">
              {t('pattern.variesHint')}
            </span>
          </span>
        </label>
      </fieldset>

      {draft.pattern === 'cycle' ? (
        <div className="space-y-4 rounded-xl border border-slate-200 p-4 dark:border-slate-800">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label help={t('help.cycleDays')}>{t('fields.cycleDays')}</Label>
              <Input
                type="number"
                min={1}
                max={366}
                value={cycleDays}
                onChange={(event) => {
                  const next = Number(event.target.value)
                  patch({
                    cycleDays: next,
                    days: draft.days.filter((day) => day.dayIndex < next),
                  })
                }}
              />
            </div>
            <div>
              <Label help={t('help.cycleAnchor')}>{t('fields.cycleAnchor')}</Label>
              <Input
                type="date"
                value={draft.cycleAnchor ?? ''}
                onChange={(event) => patch({ cycleAnchor: event.target.value })}
              />
            </div>
          </div>

          <div>
            <Label help={t('help.hours')}>{t('fields.hours')}</Label>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
              {Array.from({ length: Math.max(0, Math.min(cycleDays, 366)) }, (_, dayIndex) => (
                <label key={dayIndex} className="block text-xs">
                  <span className="mb-1 block text-slate-500 dark:text-slate-400">
                    {weekAligned
                      ? (cycleDays > 7
                          ? t('grid.weekDay', {
                              week: Math.floor(dayIndex / 7) + 1,
                              day: t(`grid.${WEEKDAY_KEYS[dayIndex % 7]!}` as never),
                            })
                          : t(`grid.${WEEKDAY_KEYS[dayIndex % 7]!}` as never))
                      : t('grid.day', { n: dayIndex + 1 })}
                  </span>
                  <Input
                    type="number"
                    min={0}
                    max={24}
                    step="0.25"
                    value={hoursAt(dayIndex)}
                    placeholder="0"
                    onChange={(event) => setHours(dayIndex, event.target.value)}
                  />
                </label>
              ))}
            </div>
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              {t('summary.total', {
                hours: decimal(sumHours(draft.days).toFixed(4)),
                days: draft.days.length,
              })}
            </p>
          </div>
        </div>
      ) : null}
    </div>
  )
}

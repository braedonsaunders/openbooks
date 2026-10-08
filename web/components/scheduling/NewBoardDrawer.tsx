'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { CalendarDays, Clock3, Factory, ChartGantt } from 'lucide-react'
import { Button, Drawer, Input, Select, cn } from '@openbooks/ui'

export interface ScopeOptions {
  readonly subsidiaries: readonly { id: string; name: string }[]
  readonly departments: readonly { id: string; name: string }[]
  readonly locations: readonly { id: string; name: string }[]
  readonly projects: readonly { id: string; name: string }[]
}

type PresetKey = 'dispatch' | 'shifts' | 'continuous' | 'projects'

/**
 * Starting points for the common ways companies schedule. Each preset only
 * fills the board settings; every value stays editable in Setup.
 */
const PRESETS: Record<PresetKey, Record<string, unknown>> = {
  dispatch: { rowKind: 'people', grain: 'day', views: ['grid', 'targets', 'calendar', 'timeline'], defaultView: 'grid', rangeDays: 14, publishPolicy: 'live', dayStarts: '07:00', dayEnds: '15:30', dayBreakMinutes: 30 },
  shifts: { rowKind: 'people', grain: 'timed', views: ['timeline', 'grid', 'calendar'], defaultView: 'timeline', rangeDays: 7, publishPolicy: 'staged', dayStarts: '09:00', dayEnds: '17:00', dayBreakMinutes: 30 },
  continuous: { rowKind: 'people', grain: 'timed', views: ['grid', 'timeline', 'calendar'], defaultView: 'grid', rangeDays: 28, publishPolicy: 'staged', dayStarts: '07:00', dayEnds: '19:00', dayBreakMinutes: 60 },
  projects: { rowKind: 'tasks', grain: 'day', views: ['gantt', 'progress'], defaultView: 'gantt', rangeDays: 14, publishPolicy: 'live', dayStarts: '07:00', dayEnds: '15:30', dayBreakMinutes: 30 },
}
const ICONS = { dispatch: CalendarDays, shifts: Clock3, continuous: Factory, projects: ChartGantt } as const

function codeFrom(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'BOARD'
}

export function NewBoardDrawer({ open, onClose, timeZone, scope, peopleEnabled, tasksEnabled }: {
  open: boolean
  onClose: () => void
  timeZone: string
  scope: ScopeOptions
  peopleEnabled: boolean
  tasksEnabled: boolean
}) {
  const t = useTranslations('scheduling')
  const router = useRouter()
  const available = useMemo(() => (Object.keys(PRESETS) as PresetKey[]).filter((key) => (PRESETS[key].rowKind === 'tasks' ? tasksEnabled : peopleEnabled)), [peopleEnabled, tasksEnabled])
  const [preset, setPreset] = useState<PresetKey>(available[0] ?? 'dispatch')
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [subsidiaryId, setSubsidiaryId] = useState('')
  const [departmentId, setDepartmentId] = useState('')
  const [locationId, setLocationId] = useState('')
  const [projectId, setProjectId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const tasks = PRESETS[preset].rowKind === 'tasks'

  async function create() {
    setSaving(true)
    setError(null)
    const boardCode = code.trim() || codeFrom(name)
    const response = await fetch('/api/admin/setup/schedule-boards', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({
        ...PRESETS[preset],
        code: boardCode,
        name: name.trim(),
        timeZone,
        weekStartsOn: 0,
        showWeekends: true,
        subsidiaryId: subsidiaryId || null,
        departmentId: tasks ? null : departmentId || null,
        locationId: tasks ? null : locationId || null,
        projectId: tasks ? projectId || null : null,
        isActive: true,
      }),
    })
    setSaving(false)
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string }
      setError(body.error ?? t('errors.save'))
      return
    }
    onClose()
    router.push(`/scheduling?board=${encodeURIComponent(boardCode)}`)
    router.refresh()
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      size="lg"
      title={t('newBoard.title')}
      description={t('newBoard.description')}
      footer={(
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>{t('newBoard.cancel')}</Button>
          <Button onClick={() => void create()} disabled={saving || !name.trim()}>{t('newBoard.create')}</Button>
        </div>
      )}
    >
      <div className="space-y-6">
        <div className="grid gap-3 sm:grid-cols-2">
          {available.map((key) => {
            const Icon = ICONS[key]
            return (
              <button
                key={key}
                type="button"
                onClick={() => setPreset(key)}
                className={cn(
                  'flex items-start gap-3 rounded-xl border p-4 text-left transition',
                  preset === key ? 'border-teal-600 bg-teal-50/60 ring-1 ring-teal-600 dark:bg-teal-950/30' : 'border-slate-200 hover:border-slate-300 dark:border-slate-800',
                )}
              >
                <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg', preset === key ? 'bg-teal-600 text-white' : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300')}>
                  <Icon className="h-4.5 w-4.5" />
                </span>
                <span>
                  <span className="block text-sm font-semibold text-slate-900 dark:text-slate-100">{t(`newBoard.presets.${key}.title`)}</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-slate-500">{t(`newBoard.presets.${key}.description`)}</span>
                </span>
              </button>
            )
          })}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-1 sm:col-span-2">
            <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{t('newBoard.name')}</span>
            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder={t('newBoard.namePlaceholder')} autoFocus />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{t('newBoard.code')}</span>
            <Input value={code} onChange={(event) => setCode(event.target.value)} placeholder={codeFrom(name || t('newBoard.namePlaceholder'))} maxLength={40} />
          </label>
          {scope.subsidiaries.length > 1 ? (
            <label className="space-y-1">
              <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{t('newBoard.subsidiary')}</span>
              <Select value={subsidiaryId} onChange={(event) => setSubsidiaryId(event.target.value)}>
                <option value="">{t('newBoard.allSubsidiaries')}</option>
                {scope.subsidiaries.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
              </Select>
            </label>
          ) : null}
          {!tasks ? (
            <>
              <label className="space-y-1">
                <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{t('newBoard.department')}</span>
                <Select value={departmentId} onChange={(event) => setDepartmentId(event.target.value)}>
                  <option value="">{t('newBoard.allDepartments')}</option>
                  {scope.departments.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
                </Select>
              </label>
              {scope.locations.length ? (
                <label className="space-y-1">
                  <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{t('newBoard.location')}</span>
                  <Select value={locationId} onChange={(event) => setLocationId(event.target.value)}>
                    <option value="">{t('newBoard.allLocations')}</option>
                    {scope.locations.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
                  </Select>
                </label>
              ) : null}
            </>
          ) : (
            <label className="space-y-1">
              <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{t('newBoard.project')}</span>
              <Select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
                <option value="">{t('newBoard.allProjects')}</option>
                {scope.projects.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
              </Select>
            </label>
          )}
        </div>
        <p className="text-xs text-slate-500">{t('newBoard.afterwards')}</p>
        {error ? <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">{error}</p> : null}
      </div>
    </Drawer>
  )
}

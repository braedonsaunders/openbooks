'use client'

import { useMemo, useState, type ComponentProps, type ReactNode } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Badge, Button, Input, Select } from '@openbooks/ui'
import { CustomFieldInputs } from '../../../components/custom-field-inputs'
import { DirtyUrlDrawer, useDirtyUrlDrawer } from '../../../components/dirty-url-drawer'
import { DrawerTabStrip } from '../../../components/drawer-tab-strip'
import { confirmDialog } from '../../../lib/confirm'
import { formatTicketHours } from '../../../lib/format'
import type { AssignmentDrawerData } from '../../../lib/resourcing/assignment-drawer'

type FormState = {
  projectId: string
  employeePartyId: string
  jobTitle: string
  weekStart: string
  plannedHours: string
  isBillable: boolean
  billItemId: string
  projectTaskId: string
  booking: 'hard' | 'soft'
  custom: Record<string, unknown>
}

type DrawerProps = AssignmentDrawerData & {
  remountKey: string
  closeHref: string
  canManage: boolean
}

function initialForm(data: AssignmentDrawerData): FormState {
  return {
    projectId: data.prefill.projectId,
    employeePartyId: data.prefill.employeePartyId,
    jobTitle: data.prefill.jobTitle,
    weekStart: data.prefill.weekStart,
    plannedHours: data.prefill.plannedHours,
    isBillable: data.assignment?.isBillable ?? true,
    billItemId: data.assignment?.billItemId ?? '',
    projectTaskId: data.assignment?.projectTaskId ?? '',
    booking: data.assignment?.booking ?? 'hard',
    custom: (data.assignment?.custom && typeof data.assignment.custom === 'object'
      ? data.assignment.custom
      : {}) as Record<string, unknown>,
  }
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block space-y-1.5"><span className="text-sm font-medium">{label}</span>{children}</label>
}

export function AssignmentDrawer(props: DrawerProps | {
  notFound: true
  remountKey: string
  closeHref: string
  canManage: boolean
}) {
  const t = useTranslations('resourcing')
  const closeHref = props.closeHref
  if ('notFound' in props) {
    return (
      <DirtyUrlDrawer open closeHref={closeHref} title={t('assignments.notFound')}>
        <p className="text-sm text-slate-600 dark:text-slate-300">{t('assignments.notFoundDescription')}</p>
      </DirtyUrlDrawer>
    )
  }
  const projectName = props.assignment ? props.projectLabel : t('assignments.new')
  return (
    <DirtyUrlDrawer open closeHref={closeHref} title={projectName ?? t('assignments.new')}>
      <AssignmentDrawerContent key={props.remountKey} {...props} />
    </DirtyUrlDrawer>
  )
}

function AssignmentDrawerContent({
  assignment,
  createMode,
  prefill,
  people,
  projects,
  items,
  tasks,
  capacity,
  actuals,
  absenceRows,
  customDefs,
  closeHref,
  canManage,
}: DrawerProps) {
  const t = useTranslations('resourcing')
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [form, setForm] = useState<FormState>(() => initialForm({
    assignment, createMode, prefill, projectLabel: null, people, projects, items, tasks,
    capacity, actuals, absenceRows, customDefs,
  }))
  const baseline = useMemo(() => JSON.stringify(initialForm({
    assignment, createMode, prefill, projectLabel: null, people, projects, items, tasks,
    capacity, actuals, absenceRows, customDefs,
  })), [assignment, createMode, prefill, people, projects, items, tasks, capacity, actuals, absenceRows, customDefs])
  const dirty = JSON.stringify(form) !== baseline
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<'details' | 'capacity' | 'actuals'>('details')
  const [refusal, setRefusal] = useState<{ message: string; remedy?: string; fields?: Record<string, string> } | null>(null)
  const close = useDirtyUrlDrawer(dirty, busy)
  const jobTitles = [...new Set(people.flatMap((person) => person.jobTitle ? [person.jobTitle] : []))].sort()
  const projectTasks = tasks.filter((task) => task.projectId === form.projectId)
  const readyToCreate = Boolean(
    form.projectId && form.weekStart && (form.employeePartyId || form.jobTitle.trim()) && form.plannedHours.trim(),
  )
  const genericMode = !assignment?.employeePartyId && Boolean(assignment?.jobTitle) || (!assignment && !form.employeePartyId && Boolean(form.jobTitle))

  function change<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }))
    setRefusal(null)
  }

  async function readFailure(response: Response): Promise<void> {
    const body = await response.json() as {
      message?: string
      error?: string
      remedy?: string
      fields?: Record<string, string>
    }
    const fields = body.fields
    setRefusal({
      message: body.message ?? body.error ?? t('assignments.saveFailed'),
      remedy: body.remedy,
      fields,
    })
  }

  async function save() {
    if (!canManage || busy) return
    setBusy(true)
    setRefusal(null)
    try {
      const response = await fetch('/api/resourcing/assignments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId: form.projectId,
          ...(form.employeePartyId ? { employeePartyId: form.employeePartyId } : { jobTitle: form.jobTitle }),
          weekStart: form.weekStart,
          plannedHours: form.plannedHours,
          isBillable: form.isBillable,
          billItemId: form.billItemId || null,
          projectTaskId: form.projectTaskId || null,
          booking: form.booking,
          source: assignment?.source ?? 'manual',
          requestId: assignment?.requestId ?? null,
          custom: form.custom,
        }),
      })
      if (!response.ok) {
        await readFailure(response)
        return
      }
      const result = await response.json() as { assignment: { id: string } }
      const params = new URLSearchParams(searchParams.toString())
      params.set('assignment', result.assignment.id)
      params.delete('person')
      params.delete('week')
      params.delete('prefillProject')
      params.delete('prefillHours')
      router.replace(`${pathname}?${params.toString()}` as never)
      router.refresh()
    } catch {
      setRefusal({ message: t('assignments.saveFailed') })
    } finally {
      setBusy(false)
    }
  }

  async function release() {
    if (!assignment || !canManage || busy || dirty) return
    setBusy(true)
    setRefusal(null)
    try {
      const response = await fetch(`/api/resourcing/assignments/${assignment.id}/release`, { method: 'POST' })
      if (!response.ok) {
        await readFailure(response)
        return
      }
      await response.json()
      router.refresh()
    } catch {
      setRefusal({ message: t('assignments.actionFailed') })
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!assignment || !canManage || busy || dirty) return
    if (!(await confirmDialog({ message: t('assignments.deleteConfirm'), confirmLabel: t('assignments.delete'), tone: 'danger' }))) return
    setBusy(true)
    setRefusal(null)
    try {
      const response = await fetch(`/api/resourcing/assignments/${assignment.id}`, { method: 'DELETE' })
      if (!response.ok) {
        await readFailure(response)
        return
      }
      await response.json()
      await close(closeHref)
    } catch {
      setRefusal({ message: t('assignments.actionFailed') })
    } finally {
      setBusy(false)
    }
  }

  const selectedCapacityTier = capacity?.capacity.tier;
  const capacityTierLabel = selectedCapacityTier?.tier === 'schedule'
    ? t('assignments.capacitySchedule')
    : selectedCapacityTier?.tier === 'labor-costing-standard'
      ? t('assignments.capacityStandard')
      : selectedCapacityTier?.tier === 'mixed'
        ? t('assignments.capacityMixed')
        : selectedCapacityTier?.tier === 'unknown'
          ? t('board.noCapacity')
          : t('assignments.capacityUnavailable');

  return (
    <div className="space-y-5">
      <DrawerTabStrip
        ariaLabel={t('assignments.tabs')}
        activeKey={tab}
        onSelect={setTab}
        tabs={[
          { key: 'details', label: t('assignments.details') },
          { key: 'capacity', label: t('assignments.capacityEvidence') },
          { key: 'actuals', label: t('assignments.actuals') },
        ]}
      />

      {tab === 'details' ? (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('assignments.project')}>
              <Select value={form.projectId} disabled={!canManage || busy || Boolean(assignment)} onChange={(event) => { setForm((current) => ({ ...current, projectId: event.target.value, projectTaskId: '' })); setRefusal(null) }}>
                <option value="">{t('assignments.chooseProject')}</option>
                {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </Select>
            </Field>
            <Field label={t('assignments.subjectType')}>
              <Select
                value={genericMode ? 'job-title' : 'person'}
                disabled={!canManage || busy || Boolean(assignment)}
                onChange={(event) => setForm((current) => ({ ...current, employeePartyId: event.target.value === 'person' ? (people[0]?.id ?? '') : '', jobTitle: event.target.value === 'job-title' ? (jobTitles[0] ?? '') : '' }))}
              >
                <option value="person">{t('assignments.person')}</option>
                <option value="job-title">{t('assignments.jobTitle')}</option>
              </Select>
            </Field>
            {genericMode ? (
              <Field label={t('assignments.jobTitle')}>
                <Select value={form.jobTitle} disabled={!canManage || busy || Boolean(assignment)} onChange={(event) => change('jobTitle', event.target.value)}>
                  <option value="">{t('assignments.chooseJobTitle')}</option>
                  {jobTitles.map((title) => <option key={title} value={title}>{title}</option>)}
                </Select>
              </Field>
            ) : (
              <Field label={t('assignments.person')}>
                <Select value={form.employeePartyId} disabled={!canManage || busy || Boolean(assignment)} onChange={(event) => change('employeePartyId', event.target.value)}>
                  <option value="">{t('assignments.choosePerson')}</option>
                  {people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
                </Select>
              </Field>
            )}
            <Field label={t('assignments.week')}>
              <Input type="date" value={form.weekStart} disabled={!canManage || busy || Boolean(assignment)} onChange={(event) => change('weekStart', event.target.value)} />
            </Field>
            <Field label={t('assignments.hours')}>
              <Input inputMode="decimal" value={form.plannedHours} disabled={!canManage || busy} onChange={(event) => change('plannedHours', event.target.value)} />
            </Field>
            <Field label={t('assignments.billItem')}>
              <Select value={form.billItemId} disabled={!canManage || busy} onChange={(event) => change('billItemId', event.target.value)}>
                <option value="">{t('assignments.noBillItem')}</option>
                {items.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </Select>
            </Field>
            <Field label={t('assignments.task')}>
              <Select value={form.projectTaskId} disabled={!canManage || busy || !form.projectId} onChange={(event) => change('projectTaskId', event.target.value)}>
                <option value="">{t('assignments.noTask')}</option>
                {projectTasks.map((task) => <option key={task.id} value={task.id}>{task.name}</option>)}
              </Select>
            </Field>
            <Field label={t('assignments.booking')}>
              <Select value={form.booking} disabled={!canManage || busy} onChange={(event) => change('booking', event.target.value as FormState['booking'])}>
                <option value="hard">{t('assignments.hard')}</option>
                <option value="soft">{t('assignments.soft')}</option>
              </Select>
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
            <input type="checkbox" checked={form.isBillable} disabled={!canManage || busy} onChange={(event) => change('isBillable', event.target.checked)} />
            {t('assignments.billable')}
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('assignments.source')}>
              <Input value={assignment?.source ?? 'manual'} readOnly aria-readonly="true" />
            </Field>
            <Field label={t('assignments.request')}>
              <Input value={assignment?.requestId ?? t('assignments.noRequest')} readOnly aria-readonly="true" />
            </Field>
          </div>
          {customDefs.length ? (
            <section className="space-y-3">
              <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t('assignments.customFields')}</h3>
              <CustomFieldInputs
                defs={customDefs as unknown as ComponentProps<typeof CustomFieldInputs>['defs']}
                values={form.custom}
                onChange={(custom) => change('custom', custom)}
                readOnly={!canManage || busy}
              />
            </section>
          ) : null}
        </div>
      ) : null}

      {tab === 'capacity' ? (
        <section className="space-y-4 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{t('assignments.capacityTier')}</span>
            <Badge variant={selectedCapacityTier?.tier === 'unknown' ? 'warning' : 'secondary'}>{capacityTierLabel}</Badge>
          </div>
          {selectedCapacityTier?.tier === 'unknown' ? <p>{t('board.capacityRemedy')}</p> : null}
          {capacity?.capacity.scheduleSources.length ? (
            <ul className="list-disc space-y-1 pl-5">
              {capacity.capacity.scheduleSources.map((source) => (
                <li key={`${source.scheduleId}:${source.date}`}>{source.date} · {source.scope}</li>
              ))}
            </ul>
          ) : null}
          <div>
            <h3 className="font-medium">{t('assignments.holidays')}</h3>
            {capacity?.holidays.applied ? (
              capacity.holidays.dates.length
                ? <ul className="list-disc pl-5">{capacity.holidays.dates.map((holiday) => <li key={`${holiday.date}:${holiday.key}`}>{holiday.date} · {holiday.name} · {capacity.holidays.jurisdiction}</li>)}</ul>
                : <p>{t('assignments.noHolidays')}</p>
            ) : <p>{capacity?.holidays.reason ?? t('assignments.noHolidays')}</p>}
          </div>
          <div>
            <h3 className="font-medium">{t('assignments.absences')}</h3>
            {absenceRows.length
              ? <ul className="list-disc pl-5">{absenceRows.map((absence) => <li key={absence.id}>{absence.onDate} · {formatTicketHours(absence.hours)} h</li>)}</ul>
              : <p>{t('assignments.noAbsences')}</p>}
          </div>
          <p>{t('assignments.netCapacity')}: {capacity?.netCapacity === null || !capacity ? t('board.noCapacity') : `${formatTicketHours(capacity.netCapacity)} h`}</p>
          {capacity?.overage ? <Badge variant="destructive">{t('assignments.capacityOverage')}</Badge> : null}
        </section>
      ) : null}

      {tab === 'actuals' ? (
        <section className="space-y-3 text-sm">
          <p className="font-medium">{t('assignments.approvedActualHours')}: {formatTicketHours(actuals.hours)} h</p>
          {actuals.entries.length ? (
            <ul className="divide-y divide-slate-200 dark:divide-slate-800">
              {actuals.entries.map((entry) => <li key={entry.id} className="py-2">{entry.workedOn} · {formatTicketHours(entry.hours)} h{entry.memo ? ` · ${entry.memo}` : ''}</li>)}
            </ul>
          ) : <p className="text-slate-500 dark:text-slate-400">{t('assignments.noActuals')}</p>}
        </section>
      ) : null}

      {refusal ? (
        <div role="alert" className="rounded-md border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-100">
          <p>{refusal.message}</p>
          {refusal.remedy ? <p className="mt-1">{refusal.remedy}</p> : null}
          {refusal.fields ? <ul className="mt-2 list-disc pl-5">{Object.entries(refusal.fields).map(([field, error]) => <li key={field}>{field}: {error}</li>)}</ul> : null}
        </div>
      ) : null}

      <div className="flex flex-wrap justify-end gap-2 border-t border-slate-200 pt-4 dark:border-slate-800">
        <Button variant="outline" disabled={busy} onClick={() => void close(closeHref)}>{t('assignments.close')}</Button>
        {assignment && canManage ? <Button variant="outline" disabled={busy || dirty} onClick={() => void release()}>{t('assignments.release')}</Button> : null}
        {assignment && canManage ? <Button variant="destructive" disabled={busy || dirty} onClick={() => void remove()}>{t('assignments.delete')}</Button> : null}
        {canManage ? <Button disabled={busy || !(dirty || (createMode && readyToCreate))} onClick={() => void save()}>{busy ? t('assignments.saving') : t('assignments.save')}</Button> : null}
      </div>
    </div>
  )
}

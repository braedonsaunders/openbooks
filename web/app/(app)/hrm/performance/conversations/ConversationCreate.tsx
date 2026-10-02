'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button, Input, Label, SearchSelect } from '@openbooks/ui'
import { DirtyUrlDrawer, useDirtyUrlDrawer } from '../../../../../components/dirty-url-drawer'
import { readApiErrorMessage } from '../../../../../lib/api-error'
type Employee = { value: string; label: string }
export function ConversationCreate({
  employees,
  closeHref,
}: {
  employees: Employee[]
  closeHref: string
}) {
  const t = useTranslations('hrm.talentWorkspace')
  return (
    <DirtyUrlDrawer open closeHref={closeHref} title={t('newConversation')}>
      <ScheduleForm employees={employees} closeHref={closeHref} />
    </DirtyUrlDrawer>
  )
}
function ScheduleForm({ employees, closeHref }: { employees: Employee[]; closeHref: string }) {
  const t = useTranslations('hrm.talentWorkspace'),
    router = useRouter(),
    [manager, setManager] = useState(''),
    [report, setReport] = useState(''),
    [when, setWhen] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null)
  const close = useDirtyUrlDrawer(when !== '' || manager !== '' || report !== '', busy)
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch('/api/hrm/one-on-ones', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          managerEmploymentId: manager,
          reportEmploymentId: report,
          scheduledAt: new Date(when).toISOString(),
        }),
      })
      if (!response.ok) {
        setError(await readApiErrorMessage(response, t('saveFailed')))
        return
      }
      const payload = (await response.json()) as { oneOnOne?: { id: string } }
      if (!payload.oneOnOne?.id) {
        setError(t('saveFailed'))
        return
      }
      const destination = new URL(closeHref, window.location.origin)
      destination.searchParams.set('one', payload.oneOnOne.id)
      router.push(destination.pathname + destination.search)
      router.refresh()
    } catch {
      setError(t('saveFailed'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <fieldset disabled={busy} className="space-y-4">
        <div>
          <Label htmlFor="conversation-manager">{t('manager')}</Label>
          <EmployeePicker
            id="conversation-manager"
            label={t('manager')}
            value={manager}
            initialOptions={employees}
            onChange={(value) => {
              setManager(value)
              if (report === value) setReport('')
            }}
          />
        </div>
        <div>
          <Label htmlFor="conversation-report">{t('employee')}</Label>
          <EmployeePicker
            id="conversation-report"
            label={t('employee')}
            value={report}
            initialOptions={employees}
            exclude={manager}
            onChange={setReport}
          />
        </div>
        <div>
          <Label htmlFor="conversation-when">{t('conversationWhen', { zone })}</Label>
          <Input
            id="conversation-when"
            type="datetime-local"
            required
            value={when}
            onChange={(event) => setWhen(event.target.value)}
          />
        </div>
        <Button type="submit" disabled={!manager || !report || manager === report || !when}>
          {t('scheduleConversation')}
        </Button>
        <Button type="button" variant="ghost" onClick={() => void close()}>
          {t('cancel')}
        </Button>
      </fieldset>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
    </form>
  )
}

function EmployeePicker({
  id,
  label,
  value,
  onChange,
  initialOptions,
  exclude,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  initialOptions: Employee[]
  exclude?: string
}) {
  const t = useTranslations('hrm.talentWorkspace')
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState(initialOptions)
  const [selected, setSelected] = useState<Employee | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      setLoading(true)
      setError(null)
      try {
        const response = await fetch(
          '/api/hrm/one-on-ones?directory=1&q=' + encodeURIComponent(query),
          { signal: controller.signal },
        )
        if (!response.ok)
          throw new Error(await readApiErrorMessage(response, t('employeeLoadFailed')))
        const payload = (await response.json()) as { employees?: Employee[] }
        if (!Array.isArray(payload.employees)) throw new Error(t('employeeLoadFailed'))
        if (!controller.signal.aborted) setOptions(payload.employees)
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : t('employeeLoadFailed'))
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }, 200)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [query, t])
  const choices = (
    selected && !options.some((option) => option.value === selected.value)
      ? [selected, ...options]
      : options
  ).filter((option) => option.value !== exclude)
  return (
    <SearchSelect
      id={id}
      ariaLabel={label}
      value={value}
      options={choices}
      onChange={(next) => {
        setSelected(choices.find((option) => option.value === next) ?? null)
        onChange(next)
      }}
      searchable
      remote
      loading={loading}
      onSearchChange={setQuery}
      placeholder={t('searchEmployees')}
      searchPlaceholder={t('searchEmployees')}
      statusMessage={error ?? undefined}
      statusTone={error ? 'error' : 'muted'}
    />
  )
}

'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button, Input, Label, Select } from '@openbooks/ui'
import {
  DirtyUrlDrawer,
  useDirtyUrlDrawer,
} from '../../../../../components/dirty-url-drawer'
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
      <ScheduleForm employees={employees} />
    </DirtyUrlDrawer>
  )
}
function ScheduleForm({ employees }: { employees: Employee[] }) {
  const t = useTranslations('hrm.talentWorkspace'),
    router = useRouter(),
    [manager, setManager] = useState(employees[0]?.value ?? ''),
    [report, setReport] = useState(employees[1]?.value ?? ''),
    [when, setWhen] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null)
  const close = useDirtyUrlDrawer(
    when !== '' ||
      manager !== employees[0]?.value ||
      report !== employees[1]?.value,
    busy,
  )
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
      router.push('/hrm/performance/conversations?one=' + payload.oneOnOne.id)
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
          <Select
            id="conversation-manager"
            value={manager}
            required
            onChange={(event) => {
              setManager(event.target.value)
              if (report === event.target.value)
                setReport(
                  employees.find((e) => e.value !== event.target.value)
                    ?.value ?? '',
                )
            }}
          >
            {employees.map((employee) => (
              <option key={employee.value} value={employee.value}>
                {employee.label}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="conversation-report">{t('employee')}</Label>
          <Select
            id="conversation-report"
            value={report}
            required
            onChange={(event) => setReport(event.target.value)}
          >
            {employees
              .filter((e) => e.value !== manager)
              .map((employee) => (
                <option key={employee.value} value={employee.value}>
                  {employee.label}
                </option>
              ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="conversation-when">
            {t('conversationWhen', { zone })}
          </Label>
          <Input
            id="conversation-when"
            type="datetime-local"
            required
            value={when}
            onChange={(event) => setWhen(event.target.value)}
          />
        </div>
        <Button type="submit" disabled={manager === report}>
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

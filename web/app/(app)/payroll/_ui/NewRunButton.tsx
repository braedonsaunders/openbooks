'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Play, Plus } from 'lucide-react'
import { Button, Label, Select } from '@openbooks/ui'

/** POST /api/payroll/runs and land in the wizard. */
async function createRun(payScheduleId: string, router: ReturnType<typeof useRouter>) {
  const res = await fetch('/api/payroll/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payScheduleId }),
  })
  const j = await res.json()
  if (!res.ok) throw new Error(j.error ?? 'failed')
  router.push(`/payroll/runs/${j.documentId}`)
}

/** One-click "Run payroll" for a known schedule (the current-period cards). */
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
          await createRun(payScheduleId, router)
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

/** Schedule picker + create — the runs-list header's New button. */
export function NewRunButton({ schedules }: { schedules: { id: string; name: string }[] }) {
  const t = useTranslations('payroll')
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [scheduleId, setScheduleId] = useState(schedules[0]?.id ?? '')
  return (
    <div className="flex items-end gap-2">
      <div>
        <Label htmlFor="pr-schedule" className="sr-only">
          {t('newRun.schedule')}
        </Label>
        <Select id="pr-schedule" value={scheduleId} onChange={(e) => setScheduleId(e.target.value)}>
          {schedules.length === 0 && <option value="">{t('newRun.noSchedules')}</option>}
          {schedules.map((schedule) => (
            <option key={schedule.id} value={schedule.id}>
              {schedule.name}
            </option>
          ))}
        </Select>
      </div>
      <Button
        disabled={busy || !scheduleId}
        onClick={async () => {
          setBusy(true)
          try {
            await createRun(scheduleId, router)
          } catch (e) {
            toast.error((e as Error).message)
            setBusy(false)
          }
        }}
      >
        <Plus size={14} aria-hidden /> {t('newRun.create')}
      </Button>
    </div>
  )
}

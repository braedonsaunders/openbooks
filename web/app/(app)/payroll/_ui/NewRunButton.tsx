'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { ChevronDown, Play, Plus } from 'lucide-react'
import { Button, Popover } from '@openbooks/ui'

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

/** "New pay run" — house dropdown pattern: one schedule = plain button,
 *  several = a Popover menu of schedules (mirrors NewDocumentButton). */
export function NewRunButton({ schedules }: { schedules: { id: string; name: string }[] }) {
  const t = useTranslations('payroll')
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  async function start(scheduleId: string) {
    setOpen(false)
    setBusy(true)
    try {
      await createRun(scheduleId, router)
    } catch (e) {
      toast.error((e as Error).message)
      setBusy(false)
    }
  }

  if (schedules.length === 0) return null
  if (schedules.length === 1) {
    return (
      <Button onClick={() => void start(schedules[0]!.id)} disabled={busy}>
        <Plus size={14} aria-hidden /> {t('newRun.create')}
      </Button>
    )
  }
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      trigger={
        <Button onClick={() => setOpen((v) => !v)} disabled={busy}>
          <Plus size={14} aria-hidden /> {t('newRun.create')}
          <ChevronDown size={14} className="opacity-60" />
        </Button>
      }
    >
      <div className="p-1">
        {schedules.map((schedule) => (
          <button
            key={schedule.id}
            type="button"
            disabled={busy}
            onClick={() => void start(schedule.id)}
            className="flex w-full items-center rounded px-2.5 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-50 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            {schedule.name}
          </button>
        ))}
      </div>
    </Popover>
  )
}

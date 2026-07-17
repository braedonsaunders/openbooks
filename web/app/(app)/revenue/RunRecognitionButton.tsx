'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Play } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@openbooks/ui'
import { money } from '../../../lib/format'

/**
 * "Run recognition" — posts all due, unposted recognition schedule lines
 * through the kernel (ar.post). Idempotent, so a repeat click that finds
 * nothing due simply reports zero.
 */
export function RunRecognitionButton({ obligationId }: { obligationId?: string } = {}) {
  const t = useTranslations('revenue')
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function run() {
    setBusy(true)
    const res = await fetch('/api/revenue/run-recognition', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(obligationId ? { obligationId } : {}),
    })
    const data = await res.json()
    if (!res.ok) {
      toast.error(data.error ?? t('run.failed'))
      setBusy(false)
      return
    }
    if (data.posted > 0) {
      toast.success(
        t('run.posted', { count: data.posted, amount: money(data.totalAmount) }) +
          (data.skipped > 0 ? ` · ${t('run.someSkipped', { count: data.skipped })}` : ''),
      )
    } else {
      toast.message(t('run.nothingDue') + (data.skipped > 0 ? ` · ${t('run.someSkipped', { count: data.skipped })}` : ''))
    }
    if (Array.isArray(data.problems) && data.problems.length) {
      for (const p of data.problems.slice(0, 3)) toast.warning(String(p))
    }
    setBusy(false)
    router.refresh()
  }

  return (
    <Button variant={obligationId ? 'outline' : 'default'} onClick={run} disabled={busy}>
      <Play size={15} /> {t('list.runRecognition')}
    </Button>
  )
}

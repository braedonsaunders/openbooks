'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button, Card, CardContent } from '@openbooks/ui'
import { money } from '../../../../lib/format'

/** Fixed-price percent-complete revenue recognition — posts the earned-to-date
 *  delta (DR Unbilled AR / CR Project revenue). Shown on the Financials tab. */
export function RecognizeRevenue({ projectId, recognizedToDate }: { projectId: string; recognizedToDate: string }) {
  const t = useTranslations('projects.recognition')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function recognize() {
    setBusy(true)
    const res = await fetch(`/api/projects/${projectId}/recognize`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    const data = await res.json()
    setBusy(false)
    if (res.ok) {
      if (Number(data.delta) === 0) toast.info(t('nothing'))
      else toast.success(t('done', { earned: money(data.earned), pct: (data.percentComplete * 100).toFixed(1), delta: money(data.delta) }))
      router.refresh()
    } else {
      toast.error(data.error ?? t('failed'))
    }
  }

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-4 p-4">
        <div>
          <div className="text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">{t('recognizedToDate')}</div>
          <div className="text-xl font-semibold tabular-nums">{money(recognizedToDate)}</div>
          <div className="text-xs text-slate-500 dark:text-slate-400">{t('hint')}</div>
        </div>
        <Button onClick={recognize} disabled={busy}>{busy ? tCommon('actions.saving') : t('recognize')}</Button>
      </CardContent>
    </Card>
  )
}

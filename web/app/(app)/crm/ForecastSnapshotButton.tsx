'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Camera } from 'lucide-react'
import { Button } from '@openbooks/ui'
import { toast } from 'sonner'
import { useTranslations } from 'next-intl'

export function ForecastSnapshotButton({
  periodStart,
  periodEnd,
  ownerUserId,
  salesTeamId,
}: {
  periodStart: string
  periodEnd: string
  ownerUserId?: string | null
  salesTeamId?: string | null
}) {
  const t = useTranslations('crm')
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function create() {
    setBusy(true)
    try {
      const target = ownerUserId ? { ownerUserId } : salesTeamId ? { ownerUserId: null, salesTeamId } : {}
      const response = await fetch('/api/crm/forecasts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ periodStart, periodEnd, ...target }),
      })
      if (!response.ok) throw new Error()
      toast.success(t('forecasts.snapshotCreated'))
      router.refresh()
    } catch {
      toast.error(t('forecasts.snapshotFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button
      onClick={create}
      disabled={busy}
      aria-label={busy ? t('forecasts.savingSnapshot') : t('forecasts.saveSnapshot')}
    >
      <Camera size={15} />
      <span className="hidden sm:inline">{busy ? t('forecasts.savingSnapshot') : t('forecasts.saveSnapshot')}</span>
    </Button>
  )
}

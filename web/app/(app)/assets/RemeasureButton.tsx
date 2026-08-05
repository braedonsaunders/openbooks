'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Scale } from 'lucide-react'
import { Button, Input, Label, Popover } from '@openbooks/ui'

/** Revalue / impair an asset to a new carrying value (posts the adjustment and
 *  rebuilds the remaining schedule). Shown in the asset drawer for in-service assets. */
export function RemeasureButton({ assetId }: { assetId: string }) {
  const t = useTranslations('assets')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [busy, setBusy] = useState(false)

  async function submit() {
    if (!value.trim()) {
      toast.error(t('remeasure.newValue'))
      return
    }
    setBusy(true)
    try {
      const res = await fetch(`/api/assets/${encodeURIComponent(assetId)}/remeasure`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newCarryingValue: value.trim(), date }),
      })
      const d = (await res.json().catch(() => ({}))) as { error?: string; kind?: string; delta?: string }
      if (!res.ok) throw new Error(d.error)
      toast.success(t('remeasure.done', { kind: d.kind ?? '', delta: d.delta ?? '0' }))
      setOpen(false)
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : tCommon('feedback.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button variant="outline">
          <Scale size={15} className="mr-1.5" />
          {t('remeasure.label')}
        </Button>
      }
    >
      <div className="w-72 space-y-3 p-3">
        <div className="space-y-1.5">
          <Label htmlFor="rm-value">{t('remeasure.newValue')}</Label>
          <Input id="rm-value" type="number" min="0" step="0.01" value={value}
            onChange={(e) => setValue(e.target.value)} placeholder="0.00" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rm-date">{t('remeasure.date')}</Label>
          <Input id="rm-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <Button className="w-full" onClick={submit} disabled={busy}>
          {busy ? t('remeasure.working') : t('remeasure.action')}
        </Button>
      </div>
    </Popover>
  )
}

'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Gauge, ListPlus } from 'lucide-react'
import { Button, Input, Label, Popover } from '@openbooks/ui'

export function DepreciationInputButton({
  assetId,
  method,
}: {
  assetId: string
  method: 'manual' | 'units_of_production'
}) {
  const t = useTranslations('assets.depreciationInput')
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [effectiveDate, setEffectiveDate] = useState(new Date().toISOString().slice(0, 10))
  const [value, setValue] = useState('')
  const [memo, setMemo] = useState('')
  const [evidenceReference, setEvidenceReference] = useState('')
  const [busy, setBusy] = useState(false)
  const production = method === 'units_of_production'

  async function submit() {
    setBusy(true)
    try {
      const response = await fetch(`/api/assets/${encodeURIComponent(assetId)}/depreciation-inputs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          effectiveDate,
          kind: production ? 'production_usage' : 'manual',
          value,
          memo,
          evidenceReference,
        }),
      })
      const result = (await response.json().catch(() => ({}))) as { error?: string; plannedAmount?: string; periodName?: string }
      if (!response.ok) throw new Error(result.error || t('failed'))
      toast.success(t('saved', { period: result.periodName ?? effectiveDate, amount: result.plannedAmount ?? '0.0000' }))
      setOpen(false)
      setValue('')
      setMemo('')
      setEvidenceReference('')
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('failed'))
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
          {production ? <Gauge size={15} className="mr-1.5" /> : <ListPlus size={15} className="mr-1.5" />}
          {production ? t('recordUsage') : t('recordManual')}
        </Button>
      }
    >
      <div className="w-80 space-y-3 p-3">
        <div className="space-y-1.5">
          <Label htmlFor="depr-input-date">{t('effectiveDate')}</Label>
          <Input id="depr-input-date" type="date" value={effectiveDate} onChange={(event) => setEffectiveDate(event.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="depr-input-value">{production ? t('productionUnits') : t('manualAmount')}</Label>
          <Input id="depr-input-value" inputMode="decimal" value={value} onChange={(event) => setValue(event.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="depr-input-memo">{t('memo')}</Label>
          <Input id="depr-input-memo" value={memo} onChange={(event) => setMemo(event.target.value)} placeholder={t('memoPlaceholder')} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="depr-input-evidence">{t('evidenceReference')}</Label>
          <Input id="depr-input-evidence" value={evidenceReference} onChange={(event) => setEvidenceReference(event.target.value)} placeholder={t('evidencePlaceholder')} />
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400">{t('replacementNotice')}</p>
        <Button className="w-full" disabled={busy || !value.trim() || !memo.trim() || !evidenceReference.trim()} onClick={submit}>
          {busy ? t('saving') : t('save')}
        </Button>
      </div>
    </Popover>
  )
}

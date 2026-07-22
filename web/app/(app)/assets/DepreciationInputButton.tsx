'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Gauge, ListPlus } from 'lucide-react'
import { Button, Input, Label, Popover, SearchSelect, Select } from '@openbooks/ui'

export function DepreciationInputButton({
  assetId,
  schedules,
}: {
  assetId: string
  schedules: { bookId: string; bookName: string; method: 'manual' | 'units_of_production' }[]
}) {
  const t = useTranslations('assets.depreciationInput')
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [effectiveDate, setEffectiveDate] = useState(new Date().toISOString().slice(0, 10))
  const [value, setValue] = useState('')
  const [memo, setMemo] = useState('')
  const [bookId, setBookId] = useState(schedules[0]?.bookId ?? '')
  const [evidenceFileId, setEvidenceFileId] = useState('')
  const [evidenceFiles, setEvidenceFiles] = useState<{ id: string; name: string }[]>([])
  const [loadingEvidence, setLoadingEvidence] = useState(false)
  const [busy, setBusy] = useState(false)
  const selectedSchedule = schedules.find((schedule) => schedule.bookId === bookId) ?? schedules[0]
  const production = selectedSchedule?.method === 'units_of_production'

  async function changeOpen(next: boolean) {
    setOpen(next)
    if (!next) return
    setLoadingEvidence(true)
    try {
      const response = await fetch(`/api/file-cabinet/attachments?targetTable=fixed_assets&targetId=${encodeURIComponent(assetId)}`)
      const result = (await response.json().catch(() => ({}))) as { attachments?: { id: string; name: string }[] }
      if (!response.ok) throw new Error(t('evidenceLoadFailed'))
      setEvidenceFiles(result.attachments ?? [])
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('evidenceLoadFailed'))
    } finally {
      setLoadingEvidence(false)
    }
  }

  async function submit() {
    setBusy(true)
    try {
      const response = await fetch(`/api/assets/${encodeURIComponent(assetId)}/depreciation-inputs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          effectiveDate,
          kind: production ? 'production_usage' : 'manual',
          bookId,
          value,
          memo,
          evidenceFileId,
        }),
      })
      const result = (await response.json().catch(() => ({}))) as { error?: string; plannedAmount?: string; periodName?: string }
      if (!response.ok) throw new Error(result.error || t('failed'))
      toast.success(t('saved', { period: result.periodName ?? effectiveDate, amount: result.plannedAmount ?? '0.0000' }))
      setOpen(false)
      setValue('')
      setMemo('')
      setEvidenceFileId('')
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
      onOpenChange={(next) => void changeOpen(next)}
      trigger={
        <Button variant="outline">
          {production ? <Gauge size={15} className="mr-1.5" /> : <ListPlus size={15} className="mr-1.5" />}
          {production ? t('recordUsage') : t('recordManual')}
        </Button>
      }
    >
      <div className="w-80 space-y-3 p-3">
        {schedules.length > 1 ? <div className="space-y-1.5">
          <Label htmlFor="depr-input-book">{t('book')}</Label>
          <Select id="depr-input-book" value={bookId} onChange={(event) => setBookId(event.target.value)}>
            {schedules.map((schedule) => <option key={schedule.bookId} value={schedule.bookId}>{schedule.bookName}</option>)}
          </Select>
        </div> : null}
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
          <Label>{t('evidenceFile')}</Label>
          <SearchSelect
            value={evidenceFileId}
            onChange={(value) => setEvidenceFileId(value ?? '')}
            options={evidenceFiles.map((file) => ({ value: file.id, label: file.name }))}
            placeholder={loadingEvidence ? t('loadingEvidence') : t('selectEvidenceFile')}
            ariaLabel={t('evidenceFile')}
            clearable
          />
          {evidenceFiles.length === 0 && !loadingEvidence ? <p className="text-xs text-amber-700 dark:text-amber-300">{t('attachEvidenceFirst')}</p> : null}
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400">{t('replacementNotice')}</p>
        <Button className="w-full" disabled={busy || !bookId || !value.trim() || !memo.trim() || !evidenceFileId} onClick={submit}>
          {busy ? t('saving') : t('save')}
        </Button>
      </div>
    </Popover>
  )
}

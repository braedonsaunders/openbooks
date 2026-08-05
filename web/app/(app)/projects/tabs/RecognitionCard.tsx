'use client'

import { useMoney } from '@/components/money-provider'
import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button, Card, CardContent, Input, Label } from '@openbooks/ui'
export interface RecognitionStatus {
  contractId: string | null
  contractValue: string
  /** 0..100 cumulative target on the obligation. */
  percentComplete: number
  overridden: boolean
  overrideValue: number | null
  earned: string
  recognized: string
  accountsMapped: boolean
}

/**
 * Read-only revenue recognition status for a fixed-price project — the
 * source platform-shaped surface: the project carries PROGRESS DATA (percent complete,
 * with a manual override), the revenue subledger carries the plan, and posting
 * happens only in the central recognition run on the Revenue page. No posting
 * from here.
 */
export function RecognitionCard({ projectId, status, canManage }: {
  projectId: string
  status: RecognitionStatus
  canManage: boolean
}) {
  const { money } = useMoney()
  const t = useTranslations('projects.recognition')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState(status.overrideValue != null ? String(status.overrideValue) : '')

  async function saveOverride(value: number | null) {
    setBusy(true)
    const res = await fetch(`/api/projects/${projectId}/percent-complete`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ percentComplete: value }),
    })
    const data = await res.json().catch(() => ({}))
    setBusy(false)
    if (res.ok) {
      toast.success(t('overrideSaved'))
      router.refresh()
    } else {
      toast.error(data.error ?? tCommon('feedback.saveFailed'))
    }
  }

  if (!status.accountsMapped) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-slate-500 dark:text-slate-400">{t('mapAccountsHint')}</CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('title')}</div>
          {status.contractId ? (
            <Link
              href={`/revenue?contract=${status.contractId}`}
              className="text-xs font-medium text-teal-700 hover:underline dark:text-teal-300"
            >
              {t('viewContract')}
            </Link>
          ) : null}
        </div>

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label={t('contractValue')} value={money(status.contractValue)} />
          <Stat
            label={t('percentComplete')}
            value={`${status.percentComplete.toFixed(1)}%`}
            hint={status.overridden ? t('sourceOverride') : t('sourceCostToCost')}
          />
          <Stat label={t('earnedToDate')} value={money(status.earned)} />
          <Stat label={t('recognizedToDate')} value={money(status.recognized)} />
        </div>

        <p className="text-xs text-slate-500 dark:text-slate-400">{t('postingHint')}</p>

        {canManage ? (
          <div className="flex flex-wrap items-end gap-2 border-t border-slate-200 pt-3 dark:border-slate-800">
            <div className="space-y-1">
              <Label htmlFor="pct-override">{t('overrideLabel')}</Label>
              <Input
                id="pct-override"
                type="number"
                min={0}
                max={100}
                step="0.1"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={t('overridePlaceholder')}
                className="w-36"
              />
            </div>
            <Button
              size="sm"
              disabled={busy || draft === '' || Number.isNaN(Number(draft))}
              onClick={() => saveOverride(Math.max(0, Math.min(100, Number(draft))))}
            >
              {busy ? tCommon('actions.saving') : tCommon('actions.save')}
            </Button>
            {status.overrideValue != null ? (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => { setDraft(''); void saveOverride(null) }}>
                {t('clearOverride')}
              </Button>
            ) : null}
            <p className="basis-full text-xs text-slate-400 dark:text-slate-500">{t('overrideHint')}</p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="space-y-0.5">
      <div className="text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      {hint ? <div className="text-xs text-slate-400 dark:text-slate-500">{hint}</div> : null}
    </div>
  )
}

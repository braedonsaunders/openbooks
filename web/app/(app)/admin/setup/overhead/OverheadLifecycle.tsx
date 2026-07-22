'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button, cn } from '@openbooks/ui'
import { PagedTable } from '../../../../../components/paged-table'
import { useMoney } from '@/components/money-provider'

export interface DriftRow {
  id: string
  name: string
  live: number
  published: number | null
}

const modeBtn = (active: boolean) =>
  cn(
    'rounded-md border px-3 py-1.5 text-sm',
    active
      ? 'border-teal-600 bg-teal-50 font-medium text-teal-700 dark:border-teal-400 dark:bg-teal-950/50 dark:text-teal-300'
      : 'border-slate-300 text-slate-600 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800',
  )

/**
 * Rate lifecycle — who maintains the published overhead card:
 *   manual     a human reviews the engine's number and clicks Publish
 *   scheduled  the worker snapshots live composites each period start
 *   live       project types read the live engine; the card is advisory
 * The drift table (live vs published, per department) is the monitoring the
 * incumbents make you do by hand — here it's always on screen.
 */
export function OverheadLifecycle(props: {
  mode: 'manual' | 'scheduled' | 'live'
  cadence: 'monthly' | 'quarterly'
  drift: DriftRow[]
}) {
  const { money } = useMoney()
  const t = useTranslations('admin.setup.entities.overhead-model.lifecycle')
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState(props.mode)
  const [cadence, setCadence] = useState(props.cadence)

  async function save() {
    setBusy(true)
    try {
      const res = await fetch('/api/admin/setup/overhead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-lifecycle', mode, cadence }),
      })
      if (!res.ok) throw new Error((await res.json()).error ?? 'failed')
      toast.success(t('saved'))
      router.refresh()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const driftPct = (r: DriftRow) =>
    r.published && r.published > 0 ? ((r.live - r.published) / r.published) * 100 : null

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('title')}</h3>
      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{t('hint')}</p>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <div className="flex gap-2">
          {(['manual', 'scheduled', 'live'] as const).map((m) => (
            <button key={m} type="button" onClick={() => setMode(m)} className={modeBtn(mode === m)}>
              {t(`modes.${m}`)}
            </button>
          ))}
        </div>
        {mode === 'scheduled' && (
          <div className="flex gap-2">
            {(['monthly', 'quarterly'] as const).map((c) => (
              <button key={c} type="button" onClick={() => setCadence(c)} className={modeBtn(cadence === c)}>
                {t(`cadences.${c}`)}
              </button>
            ))}
          </div>
        )}
        <Button size="sm" onClick={save} disabled={busy}>{t('save')}</Button>
      </div>
      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{t(`modeHints.${mode}`)}</p>

      {props.drift.length > 0 && (
        <div className="mt-3">
          <PagedTable
            rows={props.drift}
            rowKey={(r) => r.id}
            pageSize={10}
            empty={null}
            columns={[
              { key: 'dept', header: t('department'), cell: (r) => r.name, search: (r) => r.name },
              { key: 'published', header: t('published'), cell: (r) => <span className="tabular-nums">{r.published != null ? money(r.published) : '—'}</span> },
              { key: 'live', header: t('live'), cell: (r) => <span className="tabular-nums">{money(r.live)}</span> },
              {
                key: 'drift',
                header: t('drift'),
                cell: (r) => {
                  const pct = driftPct(r)
                  return (
                    <span className={cn('tabular-nums', pct != null && Math.abs(pct) >= 10 ? 'font-medium text-amber-600 dark:text-amber-400' : 'text-slate-500 dark:text-slate-400')}>
                      {pct != null ? `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%` : '—'}
                    </span>
                  )
                },
              },
            ]}
          />
        </div>
      )}
    </section>
  )
}

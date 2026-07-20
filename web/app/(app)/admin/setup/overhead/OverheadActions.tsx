'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { ArrowRight, BookMarked, Wand2, X } from 'lucide-react'
import { Button, Input, Label, cn } from '@openbooks/ui'

export interface DeptRate {
  id: string
  name: string
  composite: number
}
export interface TypeOpt {
  id: string
  name: string
}

const today = () => new Date().toISOString().slice(0, 10)

function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4" role="dialog" aria-modal="true">
      <div className={cn('max-h-[85vh] w-full overflow-y-auto rounded-lg border border-slate-200 bg-white p-5 shadow-xl dark:border-slate-700 dark:bg-slate-900', wide ? 'max-w-2xl' : 'max-w-lg')}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800">
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

/**
 * The connective UX between the rate ENGINE, the rate CARD, and PROJECT TYPES:
 *  • Publish — snapshot the live per-department composites into effective-dated
 *    overhead_rates rows (editable before committing).
 *  • Wizard — guided one-pass setup: approach → rates → apply to types.
 */
export function OverheadActions({ departments, projectTypes }: { departments: DeptRate[]; projectTypes: TypeOpt[] }) {
  const t = useTranslations('admin.setup.entities.overhead-model')
  const router = useRouter()
  const [open, setOpen] = useState<'publish' | 'wizard' | null>(null)
  const [busy, setBusy] = useState(false)

  // Publish state — pre-seeded from the live engine, editable.
  const [effectiveFrom, setEffectiveFrom] = useState(today())
  const [rates, setRates] = useState<Record<string, string>>(() =>
    Object.fromEntries(departments.filter((d) => d.composite > 0).map((d) => [d.id, d.composite.toFixed(2)])))

  // Wizard state.
  const [step, setStep] = useState(0)
  const [approach, setApproach] = useState<'rate_card' | 'live' | 'percent' | 'per_hour'>('rate_card')
  const [flatRate, setFlatRate] = useState('')
  const [typeIds, setTypeIds] = useState<Set<string>>(() => new Set(projectTypes.map((p) => p.id)))

  async function post(payload: Record<string, unknown>) {
    const res = await fetch('/api/admin/setup/overhead', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    })
    if (!res.ok) throw new Error((await res.json()).error ?? 'failed')
  }

  async function publish() {
    setBusy(true)
    try {
      await post({
        action: 'publish', effectiveFrom,
        rates: Object.entries(rates).filter(([, v]) => Number(v) > 0).map(([departmentId, v]) => ({ departmentId, ratePerHour: Number(v) })),
      })
      toast.success(t('publishDone'))
      setOpen(null)
      router.refresh()
    } catch (e) { toast.error((e as Error).message) } finally { setBusy(false) }
  }

  async function finishWizard() {
    setBusy(true)
    try {
      if (approach === 'rate_card') {
        await post({
          action: 'publish', effectiveFrom,
          rates: Object.entries(rates).filter(([, v]) => Number(v) > 0).map(([departmentId, v]) => ({ departmentId, ratePerHour: Number(v) })),
        })
      }
      const overhead =
        approach === 'percent' ? { method: 'percent_of_labor', ratePercent: Number(flatRate) || 0 }
        : approach === 'per_hour' ? { method: 'per_labor_hour', ratePerHour: Number(flatRate) || 0 }
        : { method: 'rate_engine', rateEngine: { rateSource: approach === 'live' ? 'live' : 'standard', hoursBasis: 'total_hours', dimension: 'overhead', scope: 'department' } }
      await post({ action: 'apply', projectTypeIds: [...typeIds], overhead })
      toast.success(t('wizardDone'))
      setOpen(null)
      setStep(0)
      router.refresh()
    } catch (e) { toast.error((e as Error).message) } finally { setBusy(false) }
  }

  const rateTable = (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        {departments.filter((d) => rates[d.id] !== undefined || d.composite > 0).map((d) => (
          <div key={d.id} className="space-y-1">
            <Label>{d.name}</Label>
            <div className="flex items-center gap-1.5">
              <Input type="number" step="0.01" value={rates[d.id] ?? ''} onChange={(e) => setRates({ ...rates, [d.id]: e.target.value })} />
              <span className="text-xs text-slate-400">$/hr</span>
            </div>
            <p className="text-[11px] text-slate-400">{t('liveNow', { rate: d.composite.toFixed(2) })}</p>
          </div>
        ))}
      </div>
      <div className="max-w-[12rem] space-y-1">
        <Label>{t('effectiveFrom')}</Label>
        <Input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
      </div>
    </div>
  )

  const APPROACHES = [
    { key: 'rate_card', rec: true },
    { key: 'live', rec: false },
    { key: 'per_hour', rec: false },
    { key: 'percent', rec: false },
  ] as const

  return (
    <>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => setOpen('publish')}>
          <BookMarked size={14} /> {t('publish')}
        </Button>
        <Button size="sm" onClick={() => { setStep(0); setOpen('wizard') }}>
          <Wand2 size={14} /> {t('wizard')}
        </Button>
      </div>

      {open === 'publish' ? (
        <Modal title={t('publishTitle')} onClose={() => setOpen(null)} wide>
          <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">{t('publishHint')}</p>
          {rateTable}
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setOpen(null)}>{t('cancel')}</Button>
            <Button size="sm" disabled={busy} onClick={publish}>{busy ? '…' : t('publishConfirm')}</Button>
          </div>
        </Modal>
      ) : null}

      {open === 'wizard' ? (
        <Modal title={t('wizardTitle')} onClose={() => setOpen(null)} wide>
          {step === 0 ? (
            <div className="space-y-2">
              <p className="text-xs text-slate-500 dark:text-slate-400">{t('wizardIntro')}</p>
              {APPROACHES.map((a) => (
                <button key={a.key} type="button" onClick={() => setApproach(a.key)}
                  className={cn('block w-full rounded-lg border p-3 text-left transition-colors',
                    approach === a.key ? 'border-teal-500 bg-teal-50/50 dark:border-teal-400 dark:bg-teal-950/30' : 'border-slate-200 hover:border-slate-300 dark:border-slate-700')}>
                  <span className="flex items-center gap-2 text-sm font-medium text-slate-900 dark:text-slate-100">
                    {t(`approach.${a.key}.title`)}
                    {a.rec ? <span className="rounded-full bg-teal-100 px-2 py-0.5 text-[10px] font-semibold text-teal-700 dark:bg-teal-900 dark:text-teal-300">{t('recommended')}</span> : null}
                  </span>
                  <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">{t(`approach.${a.key}.desc`)}</span>
                </button>
              ))}
            </div>
          ) : step === 1 ? (
            approach === 'rate_card' ? rateTable
            : approach === 'live' ? <p className="text-sm text-slate-600 dark:text-slate-300">{t('liveExplain')}</p>
            : (
              <div className="max-w-[14rem] space-y-1">
                <Label>{approach === 'percent' ? t('flatPercent') : t('flatPerHour')}</Label>
                <Input type="number" step="0.01" value={flatRate} onChange={(e) => setFlatRate(e.target.value)} />
              </div>
            )
          ) : (
            <div className="space-y-1.5">
              <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">{t('applyHint')}</p>
              {projectTypes.map((p) => (
                <label key={p.id} className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
                  <input type="checkbox" checked={typeIds.has(p.id)}
                    onChange={(e) => { const next = new Set(typeIds); if (e.target.checked) next.add(p.id); else next.delete(p.id); setTypeIds(next) }} />
                  {p.name}
                </label>
              ))}
            </div>
          )}
          <div className="mt-4 flex items-center justify-between">
            <span className="text-[11px] text-slate-400">{t('stepOf', { step: step + 1, total: 3 })}</span>
            <div className="flex gap-2">
              {step > 0 ? <Button variant="outline" size="sm" onClick={() => setStep(step - 1)}>{t('back')}</Button> : null}
              {step < 2 ? (
                <Button size="sm" onClick={() => setStep(step + 1)}>{t('next')} <ArrowRight size={13} /></Button>
              ) : (
                <Button size="sm" disabled={busy || typeIds.size === 0} onClick={finishWizard}>{busy ? '…' : t('finish')}</Button>
              )}
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  )
}

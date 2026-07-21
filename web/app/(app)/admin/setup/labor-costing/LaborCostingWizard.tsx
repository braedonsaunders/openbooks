'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { ArrowLeft, ArrowRight, Check, X } from 'lucide-react'
import { Button, Input, Label, Select, cn } from '@openbooks/ui'
import type { LaborCostComponent } from '@openbooks/engine/src/labor-costing.ts'

interface Opt {
  id: string
  name: string
}

/**
 * Guided setup — four plain questions, then we do the configuration. Each
 * answer maps onto the same primitives the workspace edits directly (burden
 * presets are just component lists; trade rates are ordinary scoped rates), so
 * graduating from the wizard to hand-tuning never means re-learning.
 */
/** Jurisdiction presets — the Knowify-style escape hatch. Values are honest
 * defaults the review step shows and the workspace can refine later. */
const BURDEN_PRESETS: Record<string, { components: LaborCostComponent[] }> = {
  canada: {
    components: [
      { key: 'burden', name: 'Statutory burden — CPP, EI, WSIB, EHT, vacation (est.)', kind: 'percent_of_wage', value: 13, scaleWithOvertime: true },
    ],
  },
  us: {
    components: [
      { key: 'burden', name: 'Payroll burden — FICA, FUTA/SUTA, workers comp (est.)', kind: 'percent_of_wage', value: 30, scaleWithOvertime: true },
    ],
  },
}

export function LaborCostingWizard(props: {
  open: boolean
  onClose: () => void
  onApplied: (applied: {
    mode: 'off' | 'post'
    components: LaborCostComponent[]
    laborWip: string | null
    laborClearing: string | null
    payrollVariance: string | null
  }) => void
  employees: Opt[]
  trades: Opt[]
  accounts: { id: string; label: string }[]
  hoursPerDay: number
  annualHours: number
}) {
  const t = useTranslations('admin.setup.laborCosting.wizard')
  const router = useRouter()
  const [step, setStep] = useState(0)
  const [busy, setBusy] = useState(false)

  // Q1 — burden approach.
  const [burden, setBurden] = useState<'canada' | 'us' | 'custom' | 'skip'>('canada')
  const [customPct, setCustomPct] = useState('25')
  // Q2 — wages: per-employee FIRST (each person has their own rate); an
  // optional fallback only covers anyone left blank.
  const [empRates, setEmpRates] = useState<Record<string, string>>({})
  const [empQuery, setEmpQuery] = useState('')
  const [fallbackRate, setFallbackRate] = useState('')
  // Q3 — posting.
  const [posting, setPosting] = useState<'off' | 'post'>('off')
  const guessAccount = (patterns: RegExp[]) =>
    props.accounts.find((a) => patterns.some((p) => p.test(a.label)))?.id ?? ''
  const [wipAcct, setWipAcct] = useState(() => guessAccount([/labou?r.*(wip|progress)/i, /\bwip\b/i, /work in progress/i]))
  const [clrAcct, setClrAcct] = useState(() => guessAccount([/labou?r.*clearing/i, /clearing/i, /accrued (wages|labou?r|payroll)/i]))
  const [varAcct, setVarAcct] = useState(() => guessAccount([/payroll.*variance/i, /labou?r.*variance/i, /variance/i]))

  const components = useMemo<LaborCostComponent[]>(() => {
    if (burden === 'skip') return []
    if (burden === 'custom') {
      const v = Number(customPct)
      return Number.isFinite(v) && v > 0
        ? [{ key: 'burden', name: t('customBurdenName'), kind: 'percent_of_wage', value: v, scaleWithOvertime: true }]
        : []
    }
    return BURDEN_PRESETS[burden].components
  }, [burden, customPct, t])

  const firstEmpRate = Object.values(empRates).map(Number).find((v) => v > 0)
  const exampleWage = firstEmpRate ?? (Number(fallbackRate) > 0 ? Number(fallbackRate) : 40)
  const example = (mult: number) => {
    let r = exampleWage * mult
    for (const c of components) {
      if (c.kind === 'percent_of_wage') r += (c.scaleWithOvertime ? exampleWage * mult : exampleWage) * (c.value / 100)
    }
    return r
  }

  if (!props.open) return null

  const canNext =
    step === 0 ? burden !== 'custom' || Number(customPct) > 0
    : step === 1 ? Object.values(empRates).some((v) => Number(v) > 0) || Number(fallbackRate) > 0
    : step === 2 ? posting === 'off' || (wipAcct !== '' && clrAcct !== '')
    : true

  async function finish() {
    setBusy(true)
    const today = new Date().toISOString().slice(0, 10)
    try {
      const call = async (method: string, body: Record<string, unknown>) => {
        const res = await fetch('/api/admin/setup/labor-costing', {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!res.ok) throw new Error((await res.json()).error ?? 'failed')
      }
      for (const [employeePartyId, v] of Object.entries(empRates)) {
        if (Number(v) > 0) {
          await call('POST', { action: 'save-rate', employeePartyId, tradeId: null, rate: Number(v), basis: 'hour', effectiveFrom: today })
        }
      }
      if (Number(fallbackRate) > 0) {
        await call('POST', { action: 'save-rate', employeePartyId: null, tradeId: null, rate: Number(fallbackRate), basis: 'hour', effectiveFrom: today })
      }
      await call('PUT', {
        settings: { mode: posting, hoursPerDay: props.hoursPerDay, annualHours: props.annualHours, components },
        ...(posting === 'post' ? { laborWip: wipAcct, laborClearing: clrAcct, ...(varAcct ? { payrollVariance: varAcct } : {}) } : {}),
      })
      toast.success(t('done'))
      props.onApplied({
        mode: posting,
        components,
        laborWip: posting === 'post' ? wipAcct : null,
        laborClearing: posting === 'post' ? clrAcct : null,
        payrollVariance: posting === 'post' && varAcct ? varAcct : null,
      })
      props.onClose()
      router.refresh()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const choice = (active: boolean) =>
    cn(
      'w-full rounded-lg border p-3 text-left transition-colors',
      active
        ? 'border-teal-600 bg-teal-50 dark:border-teal-400 dark:bg-teal-950/40'
        : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800/60',
    )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4" role="dialog" aria-modal="true">
      <div className="max-h-[85vh] w-full max-w-xl overflow-y-auto rounded-lg border border-slate-200 bg-white p-5 shadow-xl dark:border-slate-700 dark:bg-slate-900">
        <div className="mb-1 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('title')}</h3>
          <button type="button" onClick={props.onClose} aria-label={t('close')} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800">
            <X size={16} />
          </button>
        </div>
        {/* progress dots */}
        <div className="mb-4 flex items-center gap-1.5">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className={cn('h-1.5 rounded-full transition-all', i === step ? 'w-6 bg-teal-600 dark:bg-teal-400' : i < step ? 'w-3 bg-teal-300 dark:bg-teal-700' : 'w-3 bg-slate-200 dark:bg-slate-700')} />
          ))}
        </div>

        {step === 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{t('q1')}</p>
            <p className="text-xs text-slate-500 dark:text-slate-400">{t('q1Hint')}</p>
            {(['canada', 'us', 'custom', 'skip'] as const).map((b) => (
              <button key={b} type="button" className={choice(burden === b)} onClick={() => setBurden(b)}>
                <span className="text-sm font-medium text-slate-900 dark:text-slate-100">{t(`burden.${b}`)}</span>
                <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">{t(`burden.${b}Hint`)}</span>
                {b === 'custom' && burden === 'custom' && (
                  <span className="mt-2 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                    <Input type="number" min="1" max="100" className="h-8 w-24" value={customPct} onChange={(e) => setCustomPct(e.target.value)} />
                    <span className="text-xs text-slate-500">{t('burden.customPct')}</span>
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        {step === 1 && (
          <div className="space-y-3">
            <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{t('q2')}</p>
            <p className="text-xs text-slate-500 dark:text-slate-400">{t('q2Hint')}</p>
            <Input
              aria-label={t('searchEmployees')}
              placeholder={t('searchEmployees')}
              value={empQuery}
              onChange={(e) => setEmpQuery(e.target.value)}
            />
            <div className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
              {props.employees
                .filter((e) => !empQuery || e.name.toLowerCase().includes(empQuery.toLowerCase()))
                .map((e) => (
                  <div key={e.id} className="flex items-center gap-2">
                    <span className="flex-1 truncate text-sm text-slate-700 dark:text-slate-200">{e.name}</span>
                    <Input
                      aria-label={e.name}
                      type="number"
                      min="0"
                      step="0.25"
                      className="h-8 w-28"
                      placeholder={t('ratePlaceholder')}
                      value={empRates[e.id] ?? ''}
                      onChange={(ev) => setEmpRates((m) => ({ ...m, [e.id]: ev.target.value }))}
                    />
                  </div>
                ))}
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {t('ratedCount', { rated: Object.values(empRates).filter((v) => Number(v) > 0).length, total: props.employees.length })}
            </p>
            <div className="border-t border-slate-100 pt-2 dark:border-slate-800">
              <Label htmlFor="wiz-fallback">{t('fallbackRate')}</Label>
              <Input id="wiz-fallback" type="number" min="0" step="0.25" className="w-40" value={fallbackRate} onChange={(e) => setFallbackRate(e.target.value)} />
              <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">{t('fallbackHint')}</p>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-2">
            <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{t('q3')}</p>
            <p className="text-xs text-slate-500 dark:text-slate-400">{t('q3Hint')}</p>
            <button type="button" className={choice(posting === 'off')} onClick={() => setPosting('off')}>
              <span className="text-sm font-medium text-slate-900 dark:text-slate-100">{t('posting.off')}</span>
              <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">{t('posting.offHint')}</span>
            </button>
            <button type="button" className={choice(posting === 'post')} onClick={() => setPosting('post')}>
              <span className="text-sm font-medium text-slate-900 dark:text-slate-100">{t('posting.post')}</span>
              <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">{t('posting.postHint')}</span>
            </button>
            {posting === 'post' && (
              <div className="grid gap-2 pt-1 sm:grid-cols-2">
                <div>
                  <Label htmlFor="wiz-wip">{t('posting.wip')}</Label>
                  <Select id="wiz-wip" value={wipAcct} onChange={(e) => setWipAcct(e.target.value)}>
                    <option value="">—</option>
                    {props.accounts.map((a) => (
                      <option key={a.id} value={a.id}>{a.label}</option>
                    ))}
                  </Select>
                </div>
                <div>
                  <Label htmlFor="wiz-clr">{t('posting.clearing')}</Label>
                  <Select id="wiz-clr" value={clrAcct} onChange={(e) => setClrAcct(e.target.value)}>
                    <option value="">—</option>
                    {props.accounts.map((a) => (
                      <option key={a.id} value={a.id}>{a.label}</option>
                    ))}
                  </Select>
                </div>
                <div className="sm:col-span-2">
                  <Label htmlFor="wiz-var">{t('posting.variance')}</Label>
                  <Select id="wiz-var" value={varAcct} onChange={(e) => setVarAcct(e.target.value)}>
                    <option value="">{t('posting.varianceLater')}</option>
                    {props.accounts.map((a) => (
                      <option key={a.id} value={a.id}>{a.label}</option>
                    ))}
                  </Select>
                </div>
              </div>
            )}
          </div>
        )}

        {step === 3 && (
          <div className="space-y-3">
            <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{t('review')}</p>
            <ul className="space-y-1.5 text-sm text-slate-700 dark:text-slate-200">
              <li className="flex items-start gap-2"><Check size={15} className="mt-0.5 shrink-0 text-teal-600 dark:text-teal-400" />
                {burden === 'skip' ? t('reviewNoBurden') : t('reviewBurden', { name: components[0]?.name ?? '', pct: components[0]?.value ?? 0 })}</li>
              <li className="flex items-start gap-2"><Check size={15} className="mt-0.5 shrink-0 text-teal-600 dark:text-teal-400" />
                {t('reviewEmployeeRates', { count: Object.values(empRates).filter((v) => Number(v) > 0).length })}
                {Number(fallbackRate) > 0 && ` ${t('reviewFallback', { rate: Number(fallbackRate).toFixed(2) })}`}</li>
              <li className="flex items-start gap-2"><Check size={15} className="mt-0.5 shrink-0 text-teal-600 dark:text-teal-400" />
                {posting === 'post' ? t('reviewPosting') : t('reviewNoPosting')}</li>
            </ul>
            <div className="rounded-md bg-slate-50 p-3 text-xs dark:bg-slate-800/60">
              <span className="text-slate-500 dark:text-slate-400">{t('reviewExample', { wage: exampleWage.toFixed(2) })}</span>
              <div className="mt-1 flex gap-4 font-medium tabular-nums text-slate-900 dark:text-slate-100">
                <span>{t('exReg')}: ${example(1).toFixed(2)}/h</span>
                <span>{t('exOt')}: ${example(1.5).toFixed(2)}/h</span>
                <span>{t('exDt')}: ${example(2).toFixed(2)}/h</span>
              </div>
            </div>
            <p className="text-xs text-slate-400 dark:text-slate-500">{t('reviewNote')}</p>
            <div className="rounded-md border border-slate-200 p-3 dark:border-slate-700">
              <p className="text-xs font-medium text-slate-700 dark:text-slate-200">{t('nextSteps')}</p>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t('nextOverhead')}</p>
              <a href="/admin/setup/overhead" className="mt-1.5 inline-block text-xs font-medium text-teal-700 hover:underline dark:text-teal-300">
                {t('nextOverheadLink')} →
              </a>
            </div>
          </div>
        )}

        <div className="mt-5 flex items-center justify-between">
          <Button variant="outline" size="sm" disabled={step === 0 || busy} onClick={() => setStep((s) => s - 1)}>
            <ArrowLeft size={14} /> {t('back')}
          </Button>
          {step < 3 ? (
            <Button size="sm" disabled={!canNext || busy} onClick={() => setStep((s) => s + 1)}>
              {t('next')} <ArrowRight size={14} />
            </Button>
          ) : (
            <Button size="sm" disabled={busy} onClick={finish}>
              {busy ? t('applying') : t('apply')}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

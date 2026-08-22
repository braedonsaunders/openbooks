'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { ArrowLeft, ArrowRight, Check } from 'lucide-react'
import { Button, Input, Label, Select, UrlDrawer, cn } from '@openbooks/ui'
import type { LaborCostComponent } from '@openbooks/engine/src/labor-costing.ts'
import { useBusinessToday } from '@/components/business-date-provider'
import { useMoney } from '@/components/money-provider'

/**
 * Guided setup — four plain questions, then we do the configuration. Each
 * answer maps onto the same primitives the workspace edits directly (burden
 * presets are just component lists; trade rates are ordinary scoped rates), so
 * graduating from the wizard to hand-tuning never means re-learning.
 */
export function LaborCostingWizard(props: {
  open: boolean
  closeHref: string
  onApplied: (applied: { mode: 'off' | 'post'; components: LaborCostComponent[]; laborWip: string | null; laborClearing: string | null; payrollVariance: string | null }) => void
  accounts: { id: string; label: string }[]
  hoursPerDay: number
  annualHours: number
}) {
  const { money } = useMoney()
  const today = useBusinessToday()
  const t = useTranslations('admin.setup.laborCosting.wizard')
  const tc = useTranslations('admin.setup.laborCosting.components')
  const router = useRouter()
  const [step, setStep] = useState(0)
  const [busy, setBusy] = useState(false)

  // Q1 — burden approach.
  const [burden, setBurden] = useState<'canada' | 'us' | 'custom' | 'skip'>('canada')
  const [customPct, setCustomPct] = useState('25')
  // Q2 — wages are set on each EMPLOYEE'S RECORD (like every accounting
  // system); the wizard only offers the optional org-wide fallback.
  const [fallbackRate, setFallbackRate] = useState('')
  // Q3 — posting.
  const [posting, setPosting] = useState<'off' | 'post'>('off')
  const guessAccount = (patterns: RegExp[]) => props.accounts.find((a) => patterns.some((p) => p.test(a.label)))?.id ?? ''
  const [wipAcct, setWipAcct] = useState(() => guessAccount([/labou?r.*(wip|progress)/i, /\bwip\b/i, /work in progress/i]))
  const [clrAcct, setClrAcct] = useState(() => guessAccount([/labou?r.*clearing/i, /clearing/i, /accrued (wages|labou?r|payroll)/i]))
  const [varAcct, setVarAcct] = useState(() => guessAccount([/payroll.*variance/i, /labou?r.*variance/i, /variance/i]))

  const components = useMemo<LaborCostComponent[]>(() => {
    if (burden === 'skip') return []
    if (burden === 'custom') {
      const v = Number(customPct)
      return Number.isFinite(v) && v > 0
        ? [
            {
              key: 'burden',
              name: t('customBurdenName'),
              kind: 'percent_of_wage',
              value: v,
              scaleWithOvertime: true,
            },
          ]
        : []
    }
    return [
      {
        key: 'burden',
        name: burden === 'canada' ? tc('presetCaName') : tc('presetUsName'),
        kind: 'percent_of_wage',
        value: burden === 'canada' ? 13 : 30,
        scaleWithOvertime: true,
      },
    ]
  }, [burden, customPct, t, tc])

  const exampleWage = Number(fallbackRate) > 0 ? Number(fallbackRate) : 40
  const example = (mult: number) => {
    let r = exampleWage * mult
    for (const c of components) {
      if (c.kind === 'percent_of_wage') r += (c.scaleWithOvertime ? exampleWage * mult : exampleWage) * (Number(c.value) / 100)
    }
    return r
  }

  if (!props.open) return null

  const canNext = step === 0 ? burden !== 'custom' || Number(customPct) > 0 : step === 1 ? true : step === 2 ? posting === 'off' || (wipAcct !== '' && clrAcct !== '') : true

  async function finish() {
    setBusy(true)
    try {
      const call = async (method: string, body: Record<string, unknown>) => {
        const res = await fetch('/api/admin/setup/labor-costing', {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!res.ok) throw new Error((await res.json()).error ?? 'failed')
      }
      if (Number(fallbackRate) > 0) {
        await call('POST', {
          action: 'save-rate',
          employeePartyId: null,
          tradeId: null,
          rate: Number(fallbackRate),
          basis: 'hour',
          effectiveFrom: today,
        })
      }
      await call('PUT', {
        settings: {
          mode: posting,
          hoursPerDay: props.hoursPerDay,
          annualHours: props.annualHours,
          components,
        },
        ...(posting === 'post'
          ? {
              laborWip: wipAcct,
              laborClearing: clrAcct,
              ...(varAcct ? { payrollVariance: varAcct } : {}),
            }
          : {}),
      })
      toast.success(t('done'))
      props.onApplied({
        mode: posting,
        components,
        laborWip: posting === 'post' ? wipAcct : null,
        laborClearing: posting === 'post' ? clrAcct : null,
        payrollVariance: posting === 'post' && varAcct ? varAcct : null,
      })
      router.push(props.closeHref)
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
      active ? 'border-teal-600 bg-teal-50 dark:border-teal-400 dark:bg-teal-950/40' : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800/60',
    )

  return (
    <UrlDrawer
      open
      closeHref={props.closeHref}
      size="lg"
      title={t('title')}
      description={t('description')}
      footer={
        <div className="flex w-full items-center justify-between">
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
      }
    >
      <div className="p-1">
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
            <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
              <p className="text-sm text-slate-700 dark:text-slate-200">{t('wagesOnRecord')}</p>
              <Link href="/entities/employees" className="mt-1.5 inline-block text-xs font-medium text-teal-700 hover:underline dark:text-teal-300">
                {t('openEmployees')} →
              </Link>
            </div>
            <div>
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
                      <option key={a.id} value={a.id}>
                        {a.label}
                      </option>
                    ))}
                  </Select>
                </div>
                <div>
                  <Label htmlFor="wiz-clr">{t('posting.clearing')}</Label>
                  <Select id="wiz-clr" value={clrAcct} onChange={(e) => setClrAcct(e.target.value)}>
                    <option value="">—</option>
                    {props.accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.label}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="sm:col-span-2">
                  <Label htmlFor="wiz-var">{t('posting.variance')}</Label>
                  <Select id="wiz-var" value={varAcct} onChange={(e) => setVarAcct(e.target.value)}>
                    <option value="">{t('posting.varianceLater')}</option>
                    {props.accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.label}
                      </option>
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
              <li className="flex items-start gap-2">
                <Check size={15} className="mt-0.5 shrink-0 text-teal-600 dark:text-teal-400" />
                {burden === 'skip'
                  ? t('reviewNoBurden')
                  : t('reviewBurden', {
                      name: components[0]?.name ?? '',
                      pct: components[0]?.value ?? 0,
                    })}
              </li>
              <li className="flex items-start gap-2">
                <Check size={15} className="mt-0.5 shrink-0 text-teal-600 dark:text-teal-400" />
                {Number(fallbackRate) > 0
                  ? t('reviewFallback', {
                      rate: money(Number(fallbackRate)),
                    })
                  : t('reviewWagesOnRecord')}
              </li>
              <li className="flex items-start gap-2">
                <Check size={15} className="mt-0.5 shrink-0 text-teal-600 dark:text-teal-400" />
                {posting === 'post' ? t('reviewPosting') : t('reviewNoPosting')}
              </li>
            </ul>
            <div className="rounded-md bg-slate-50 p-3 text-xs dark:bg-slate-800/60">
              <span className="text-slate-500 dark:text-slate-400">{t('reviewExample', { wage: money(exampleWage) })}</span>
              <div className="mt-1 flex gap-4 font-medium tabular-nums text-slate-900 dark:text-slate-100">
                <span>
                  {t('exReg')}: {money(example(1))}/h
                </span>
                <span>
                  {t('exOt')}: {money(example(1.5))}/h
                </span>
                <span>
                  {t('exDt')}: {money(example(2))}/h
                </span>
              </div>
            </div>
            <p className="text-xs text-slate-400 dark:text-slate-500">{t('reviewNote')}</p>
            <div className="rounded-md border border-slate-200 p-3 dark:border-slate-700">
              <p className="text-xs font-medium text-slate-700 dark:text-slate-200">{t('nextSteps')}</p>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t('nextOverhead')}</p>
              <Link href="/admin/setup/overhead" className="mt-1.5 inline-block text-xs font-medium text-teal-700 hover:underline dark:text-teal-300">
                {t('nextOverheadLink')} →
              </Link>
            </div>
          </div>
        )}
      </div>
    </UrlDrawer>
  )
}

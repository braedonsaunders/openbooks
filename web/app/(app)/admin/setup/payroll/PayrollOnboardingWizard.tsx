'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { motion, useReducedMotion } from 'framer-motion'
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCircle2,
  CircleAlert,
  Globe2,
  Loader2,
  PartyPopper,
  Sparkles,
} from 'lucide-react'
import { cn, Input, Label, Select } from '@openbooks/ui'
import { WizardShell } from '../wizard/WizardShell'

/**
 * Payroll onboarding wizard — the module's first-run flow, composed on the
 * SAME stepper as the org onboarding SetupWizard (WizardShell). Every step
 * writes through the EXISTING settings APIs (`/api/payroll/settings`, the
 * generic `/api/admin/setup/pay-schedules` entity route); the wizard is
 * composition, not a write path. The step list and the review checklist both
 * derive from `payrollSetupState` (engine/src/payroll-readiness.ts) — the
 * same org-level checks the pay-run pre-flight performs — so the wizard and
 * readiness can never disagree about what is still missing.
 */

type Step = 'packs' | 'accounts' | 'schedule' | 'vendors' | 'rails' | 'review' | 'applying' | 'done'

const STEP_ORDER: Step[] = ['packs', 'accounts', 'schedule', 'vendors', 'rails', 'review', 'applying', 'done']

/** Which wizard step resolves each payrollSetupState check code. */
const STEP_FOR_CODE: Record<string, Step> = {
  'setup.pack': 'packs',
  'setup.wageExpense': 'accounts',
  'setup.netPay': 'accounts',
  'setup.laborClearing': 'accounts',
  'setup.slot': 'accounts',
  'setup.schedule': 'schedule',
  'setup.remittanceVendor': 'vendors',
  'setup.paymentRail': 'rails',
}

interface SetupCheck {
  code: string
  severity: 'blocker' | 'warning'
  ok: boolean
  detail?: string
  href?: string
}

/** GET /api/payroll/settings — the wizard's whole world, refetched per step. */
interface SettingsPayload {
  settings: Record<string, unknown>
  packs: { country: string; slots: { key: string; accountId: string | null }[] }[]
  paymentMethods: { eftFallbackToCheque: boolean }
  installable: string[]
  accounts: { id: string; label: string }[]
  vendors: { id: string; label: string }[]
  setup: { installedCountries: string[]; checks: SetupCheck[]; blockers: number; warnings: number }
}

/** Countries → their pack's declared statutory remittance vendor settings keys. */
export type VendorKeysByCountry = Record<string, string[]>

const FREQUENCY_PERIODS: Record<string, number> = {
  weekly: 52,
  biweekly: 26,
  semi_monthly: 24,
  monthly: 12,
}

/** settingsPage.packs.* i18n keys per pack country. */
const PACK_I18N: Record<string, 'canada' | 'us'> = { CA: 'canada', US: 'us' }

export function PayrollOnboardingWizard(props: {
  onClose: () => void
  vendorKeysByCountry: VendorKeysByCountry
  frequencies: { value: string; labelKey: string }[]
  /** Whether the viewer may create registry entities (the pay schedule). */
  canManageEntities: boolean
  /** Existing active pay schedules, for the keep-or-create step. */
  schedules: { id: string; name: string }[]
  bankProfiles: { id: string; name: string; format: string; configured: boolean }[]
}) {
  const t = useTranslations('payroll.setupWizard')
  const tSettings = useTranslations('payroll.settingsPage')
  const tPayroll = useTranslations('payroll')
  const tOptions = useTranslations('admin.setup')
  const router = useRouter()
  const reduceMotion = useReducedMotion()

  const [data, setData] = useState<SettingsPayload | null>(null)
  const [stepIdx, setStepIdx] = useState(0)
  const [busy, setBusy] = useState(false)
  const [transitioning, setTransitioning] = useState(false)
  const stepTransitionLocked = useRef(false)

  // ─── Per-step form state ────────────────────────────────────────────────
  const [selectedCountries, setSelectedCountries] = useState<Set<string>>(() => new Set())
  const [wageExpenseAccountId, setWageExpenseAccountId] = useState('')
  const [netPayAccountId, setNetPayAccountId] = useState('')
  const [slotAccounts, setSlotAccounts] = useState<Record<string, Record<string, string>>>({})
  const [scheduleMode, setScheduleMode] = useState<'keep' | 'create'>('keep')
  const [scheduleName, setScheduleName] = useState('')
  const [frequency, setFrequency] = useState('biweekly')
  const [periodsPerYear, setPeriodsPerYear] = useState(String(FREQUENCY_PERIODS.biweekly))
  const [anchorPeriodEnd, setAnchorPeriodEnd] = useState('')
  const [createdSchedule, setCreatedSchedule] = useState<{ id: string; name: string } | null>(null)
  const [vendorChoices, setVendorChoices] = useState<Record<string, string>>({})
  const [eftFallbackToCheque, setEftFallbackToCheque] = useState(true)

  // ─── Data loading — everything comes from the settings API ─────────────
  async function reload(): Promise<SettingsPayload> {
    const res = await fetch('/api/payroll/settings')
    const payload = (await res.json()) as SettingsPayload & { error?: string }
    if (!res.ok) throw new Error(payload.error ?? 'failed')
    setData(payload)
    return payload
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const payload = await reload()
        if (cancelled) return
        // Seed the form state from the org's live configuration.
        setSelectedCountries(new Set(payload.setup.installedCountries))
        setWageExpenseAccountId(String(payload.settings.wageExpenseAccountId ?? ''))
        setNetPayAccountId(String(payload.settings.netPayAccountId ?? ''))
        setSlotAccounts(Object.fromEntries(payload.packs.map((pack) => [
          pack.country,
          Object.fromEntries(pack.slots.map((slot) => [slot.key, slot.accountId ?? ''])),
        ])))
        setVendorChoices(Object.fromEntries(
          Object.values(props.vendorKeysByCountry).flat().map((key) => [
            key, String(payload.settings[key] ?? ''),
          ]),
        ))
        setEftFallbackToCheque(payload.paymentMethods.eftFallbackToCheque)
        setScheduleMode(props.schedules.length > 0 ? 'keep' : 'create')
      } catch (e) {
        toast.error((e as Error).message)
        props.onClose()
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ─── Step list — derived from the readiness check → step mapping ────────
  const vendorKeys = useMemo(
    () => [...selectedCountries].flatMap((country) => props.vendorKeysByCountry[country] ?? []),
    [props.vendorKeysByCountry, selectedCountries],
  )
  const steps = useMemo<Step[]>(
    () => STEP_ORDER.filter((step) => step !== 'vendors' || vendorKeys.length > 0),
    [vendorKeys],
  )
  const step = steps[stepIdx]

  const hasSchedule = props.schedules.length > 0 || createdSchedule !== null
    || (data?.setup.checks.some((c) => c.code === 'setup.schedule' && c.ok) ?? false)

  // ─── Navigation (same double-click guard as the org SetupWizard) ────────
  function moveStep(delta: -1 | 1) {
    if (stepTransitionLocked.current) return
    stepTransitionLocked.current = true
    setTransitioning(true)
    setStepIdx((current) => Math.max(0, Math.min(steps.indexOf('review'), current + delta)))
    window.setTimeout(() => {
      stepTransitionLocked.current = false
      setTransitioning(false)
    }, reduceMotion ? 120 : 300)
  }

  // ─── Writes — one per step, all through the existing settings APIs ──────

  async function commitStep(current: Step): Promise<void> {
    if (!data) return
    if (current === 'packs') {
      const installed = new Set(data.setup.installedCountries)
      for (const country of selectedCountries) {
        if (installed.has(country)) continue
        const res = await fetch('/api/payroll/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'install-pack', country }),
        })
        const j = await res.json()
        if (!res.ok) throw new Error(j.error ?? 'failed')
      }
      const payload = await reload()
      // A just-installed pack's slots become editable on the next step.
      setSlotAccounts((currentSlots) => Object.fromEntries(payload.packs.map((pack) => [
        pack.country,
        Object.fromEntries(pack.slots.map((slot) => [
          slot.key,
          currentSlots[pack.country]?.[slot.key] ?? slot.accountId ?? '',
        ])),
      ])))
      return
    }
    if (current === 'accounts') {
      const res = await fetch('/api/payroll/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wageExpenseAccountId: wageExpenseAccountId || null,
          netPayAccountId: netPayAccountId || null,
          slotAccounts: Object.fromEntries(Object.entries(slotAccounts).map(([country, slots]) => [
            country,
            Object.fromEntries(Object.entries(slots).map(([key, value]) => [key, value || null])),
          ])),
        }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? 'failed')
      await reload()
      return
    }
    if (current === 'schedule') {
      if (scheduleMode === 'keep' || createdSchedule) return
      const res = await fetch('/api/admin/setup/pay-schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: scheduleName.trim(),
          frequency,
          periodsPerYear: Number(periodsPerYear),
          anchorPeriodEnd,
          isDefault: props.schedules.length === 0,
          isActive: true,
        }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? 'failed')
      setCreatedSchedule({ id: String(j.id ?? ''), name: scheduleName.trim() })
      await reload()
      return
    }
    if (current === 'vendors') {
      const res = await fetch('/api/payroll/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.fromEntries(
          vendorKeys.map((key) => [key, vendorChoices[key] || null]),
        )),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? 'failed')
      await reload()
      return
    }
    if (current === 'rails') {
      const res = await fetch('/api/payroll/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eftFallbackToCheque }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? 'failed')
      await reload()
      return
    }
  }

  async function next() {
    if (busy || stepTransitionLocked.current) return
    setBusy(true)
    try {
      await commitStep(step)
      moveStep(1)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  function back() {
    if (stepIdx > 0) moveStep(-1)
  }

  /** Finish: re-run the statutory component seed for every installed pack. */
  async function apply() {
    if (busy || stepTransitionLocked.current || !data) return
    setBusy(true)
    setStepIdx(steps.indexOf('applying'))
    try {
      for (const country of selectedCountries) {
        const res = await fetch('/api/payroll/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'seed-components', country }),
        })
        const j = await res.json()
        if (!res.ok) throw new Error(j.error ?? 'failed')
      }
      setStepIdx(steps.indexOf('done'))
      setTimeout(() => {
        props.onClose()
        router.refresh()
      }, 2000)
    } catch (e) {
      toast.error((e as Error).message)
      setStepIdx(steps.indexOf('review'))
    } finally {
      setBusy(false)
    }
  }

  const canNext =
    step === 'packs'
      ? selectedCountries.size > 0
      : step === 'schedule'
        ? scheduleMode === 'keep'
          ? hasSchedule
          : Boolean(createdSchedule)
            || Boolean(scheduleName.trim() && frequency && Number(periodsPerYear) > 0 && anchorPeriodEnd)
        : true

  const progressSteps = steps.slice(0, steps.indexOf('applying'))

  /** Localize a readiness check the same way the run wizard does. */
  const checkLabel = (check: SetupCheck): string => {
    // A vendor check's detail carries the settings key; show its field label.
    const detail = check.code === 'setup.remittanceVendor'
      ? (() => {
          const [country = '', key = ''] = (check.detail ?? '').split(' · ')
          return tSettings.has(`fields.${key}` as never)
            ? `${country} · ${tSettings(`fields.${key}` as never)}`
            : (check.detail ?? '')
        })()
      : (check.detail ?? '')
    return tPayroll.has(`wizard.readiness.codes.${check.code}` as never)
      ? tPayroll(`wizard.readiness.codes.${check.code}`, { count: 0, detail })
      : check.code
  }
  const accountPicker = (
    id: string,
    value: string,
    onChange: (next: string) => void,
  ) => (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">—</option>
      {(data?.accounts ?? []).map((account) => (
        <option key={account.id} value={account.id}>{account.label}</option>
      ))}
    </Select>
  )

  return (
    <WizardShell
      testId="payroll-setup-wizard"
      stepKey={data ? step : 'loading'}
      progress={
        data && stepIdx < steps.indexOf('applying')
          ? { index: stepIdx, total: progressSteps.length }
          : null
      }
      skip={
        !busy && step !== 'applying' && step !== 'done'
          ? { label: t('close'), onClick: props.onClose, disabled: transitioning }
          : null
      }
      footer={
        data && stepIdx < steps.indexOf('applying')
          ? {
              back:
                stepIdx > 0
                  ? {
                      label: (
                        <>
                          <ArrowLeft size={16} /> {t('back')}
                        </>
                      ),
                      onClick: back,
                      disabled: busy || transitioning,
                    }
                  : null,
              primary:
                step === 'review'
                  ? {
                      label: (
                        <>
                          <Sparkles size={16} /> {t('finish')}
                        </>
                      ),
                      onClick: apply,
                      disabled: busy || transitioning,
                    }
                  : {
                      label: (
                        <>
                          {t('next')} <ArrowRight size={16} />
                        </>
                      ),
                      onClick: next,
                      disabled: !canNext || busy || transitioning,
                    },
            }
          : null
      }
    >
      {!data && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <motion.div animate={{ rotate: 360 }} transition={{ duration: 1.2, repeat: Infinity, ease: 'linear' }}>
            <Loader2 className="text-teal-500" size={40} />
          </motion.div>
        </div>
      )}
      {data && step === 'packs' && (
        <StepFrame title={t('packs.title')} description={t('packs.description')}>
          <div className="grid gap-3 sm:grid-cols-2">
            {data.installable.map((country) => {
              const selected = selectedCountries.has(country)
              const installed = data.setup.installedCountries.includes(country)
              const packKey = PACK_I18N[country]
              return (
                <button
                  key={country}
                  type="button"
                  aria-pressed={selected}
                  disabled={installed}
                  onClick={() => setSelectedCountries((current) => {
                    const nextSet = new Set(current)
                    if (nextSet.has(country)) nextSet.delete(country)
                    else nextSet.add(country)
                    return nextSet
                  })}
                  className={cn(
                    'relative flex items-start gap-3 rounded-xl border p-4 text-left transition-colors',
                    selected
                      ? 'border-teal-500 bg-teal-50 ring-2 ring-teal-500/20 dark:border-teal-400 dark:bg-teal-950/40'
                      : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800/60',
                    installed && 'cursor-default',
                  )}
                >
                  <span className={cn('rounded-lg p-2', selected ? 'bg-teal-600 text-white' : 'bg-slate-100 text-slate-400 dark:bg-slate-800')}>
                    <Globe2 size={18} />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-slate-900 dark:text-slate-100">
                      {packKey ? tSettings(`packs.${packKey}.title`) : country}
                    </span>
                    <span className="mt-0.5 block text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                      {packKey ? tSettings(`packs.${packKey}.description`) : country}
                    </span>
                    {installed && (
                      <span className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-teal-100 px-2 py-0.5 text-[11px] font-medium text-teal-700 dark:bg-teal-900/60 dark:text-teal-300">
                        <Check size={11} strokeWidth={3} /> {tSettings('packs.installed')}
                      </span>
                    )}
                  </span>
                  {selected && (
                    <span className="absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded-full bg-teal-500">
                      <Check className="text-white" size={12} strokeWidth={3} />
                    </span>
                  )}
                </button>
              )
            })}
          </div>
          <p className="rounded-lg bg-slate-50 p-3 text-xs leading-relaxed text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
            {t('packs.note')}
          </p>
        </StepFrame>
      )}
      {data && step === 'accounts' && (
        <StepFrame title={t('accounts.title')} description={t('accounts.description')}>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="pw-wage-expense" help={t('accounts.wageExpenseHelp')}>
                {tSettings('fields.wageExpenseAccountId')}
              </Label>
              {accountPicker('pw-wage-expense', wageExpenseAccountId, setWageExpenseAccountId)}
            </div>
            <div>
              <Label htmlFor="pw-net-pay" help={t('accounts.netPayHelp')}>
                {tSettings('fields.netPayAccountId')}
              </Label>
              {accountPicker('pw-net-pay', netPayAccountId, setNetPayAccountId)}
            </div>
          </div>
          {data.packs.filter((pack) => selectedCountries.has(pack.country)).map((pack) => (
            <fieldset key={pack.country} className="space-y-3 rounded-xl border border-slate-200 p-4 dark:border-slate-700">
              <legend className="px-1 text-sm font-semibold text-slate-800 dark:text-slate-100">
                {PACK_I18N[pack.country]
                  ? tSettings(`packAccounts.${pack.country}.title` as never)
                  : pack.country}
              </legend>
              <div className="grid gap-3 sm:grid-cols-2">
                {pack.slots.map((slot) => (
                  <div key={slot.key}>
                    <Label
                      htmlFor={`pw-slot-${pack.country}-${slot.key}`}
                      help={t('accounts.slotHelp')}
                    >
                      {tSettings.has(`packAccounts.${pack.country}.slots.${slot.key}` as never)
                        ? tSettings(`packAccounts.${pack.country}.slots.${slot.key}` as never)
                        : slot.key}
                    </Label>
                    {accountPicker(
                      `pw-slot-${pack.country}-${slot.key}`,
                      slotAccounts[pack.country]?.[slot.key] ?? '',
                      (nextValue) => setSlotAccounts((current) => ({
                        ...current,
                        [pack.country]: { ...current[pack.country], [slot.key]: nextValue },
                      })),
                    )}
                  </div>
                ))}
              </div>
            </fieldset>
          ))}
        </StepFrame>
      )}
      {data && step === 'schedule' && (
        <StepFrame title={t('schedule.title')} description={t('schedule.description')}>
          {props.schedules.length > 0 && (
            <div className="space-y-2">
              {props.schedules.map((schedule) => (
                <div
                  key={schedule.id}
                  className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 dark:border-slate-700 dark:text-slate-200"
                >
                  <CheckCircle2 size={15} className="text-teal-600 dark:text-teal-400" />
                  {schedule.name}
                </div>
              ))}
              <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                <input
                  type="checkbox"
                  checked={scheduleMode === 'create'}
                  onChange={(e) => setScheduleMode(e.target.checked ? 'create' : 'keep')}
                  className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500 dark:border-slate-600"
                />
                {t('schedule.addAnother')}
              </label>
            </div>
          )}
          {createdSchedule && (
            <p className="flex items-center gap-2 rounded-lg border border-teal-200 bg-teal-50 px-3 py-2 text-sm text-teal-800 dark:border-teal-900 dark:bg-teal-950/40 dark:text-teal-200">
              <CheckCircle2 size={15} /> {t('schedule.created', { name: createdSchedule.name })}
            </p>
          )}
          {scheduleMode === 'create' && !createdSchedule && (
            props.canManageEntities ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="pw-schedule-name" help={t('schedule.nameHelp')}>
                    {t('schedule.name')}
                  </Label>
                  <Input
                    id="pw-schedule-name"
                    value={scheduleName}
                    onChange={(e) => setScheduleName(e.target.value)}
                    placeholder={t('schedule.namePlaceholder')}
                  />
                </div>
                <div>
                  <Label htmlFor="pw-schedule-frequency" help={t('schedule.frequencyHelp')}>
                    {t('schedule.frequency')}
                  </Label>
                  <Select
                    id="pw-schedule-frequency"
                    value={frequency}
                    onChange={(e) => {
                      setFrequency(e.target.value)
                      const periods = FREQUENCY_PERIODS[e.target.value]
                      if (periods) setPeriodsPerYear(String(periods))
                    }}
                  >
                    {props.frequencies.map((option) => (
                      <option key={option.value} value={option.value}>
                        {tOptions(option.labelKey as never)}
                      </option>
                    ))}
                  </Select>
                </div>
                <div>
                  <Label htmlFor="pw-schedule-periods" help={t('schedule.periodsHelp')}>
                    {t('schedule.periods')}
                  </Label>
                  <Input
                    id="pw-schedule-periods"
                    inputMode="numeric"
                    value={periodsPerYear}
                    onChange={(e) => setPeriodsPerYear(e.target.value)}
                  />
                </div>
                <div>
                  <Label htmlFor="pw-schedule-anchor" help={t('schedule.anchorHelp')}>
                    {t('schedule.anchor')}
                  </Label>
                  <Input
                    id="pw-schedule-anchor"
                    type="date"
                    value={anchorPeriodEnd}
                    onChange={(e) => setAnchorPeriodEnd(e.target.value)}
                  />
                </div>
              </div>
            ) : (
              <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                {t('schedule.noPermission')}
              </p>
            )
          )}
        </StepFrame>
      )}
      {data && step === 'vendors' && (
        <StepFrame title={t('vendors.title')} description={t('vendors.description')}>
          <div className="grid gap-3 sm:grid-cols-2">
            {vendorKeys.map((key) => (
              <div key={key}>
                <Label htmlFor={`pw-vendor-${key}`} help={t('vendors.help')}>
                  {tSettings.has(`fields.${key}` as never) ? tSettings(`fields.${key}` as never) : key}
                </Label>
                <Select
                  id={`pw-vendor-${key}`}
                  value={vendorChoices[key] ?? ''}
                  onChange={(e) => setVendorChoices((current) => ({ ...current, [key]: e.target.value }))}
                >
                  <option value="">—</option>
                  {data.vendors.map((vendor) => (
                    <option key={vendor.id} value={vendor.id}>{vendor.label}</option>
                  ))}
                </Select>
              </div>
            ))}
          </div>
          <p className="rounded-lg bg-slate-50 p-3 text-xs leading-relaxed text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
            {t('vendors.note')}
          </p>
        </StepFrame>
      )}
      {data && step === 'rails' && (
        <StepFrame title={t('rails.title')} description={t('rails.description')}>
          <label className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-300">
            <input
              type="checkbox"
              checked={eftFallbackToCheque}
              onChange={(e) => setEftFallbackToCheque(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500 dark:border-slate-600"
            />
            <span>
              {tSettings('paymentMethods.fallback')}
              <span className="block text-xs text-slate-500 dark:text-slate-400">
                {eftFallbackToCheque
                  ? tSettings('paymentMethods.fallbackOn')
                  : tSettings('paymentMethods.fallbackOff')}
              </span>
            </span>
          </label>
          <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50/70 p-4 dark:border-slate-700 dark:bg-slate-950/40">
            <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t('rails.eftTitle')}</p>
            {props.bankProfiles.length === 0 ? (
              <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">{t('rails.eftNone')}</p>
            ) : (
              <ul className="space-y-1.5 text-sm text-slate-700 dark:text-slate-200">
                {props.bankProfiles.map((profile) => (
                  <li key={profile.id} className="flex items-center gap-2">
                    {profile.configured ? (
                      <CheckCircle2 size={15} className="shrink-0 text-teal-600 dark:text-teal-400" />
                    ) : (
                      <CircleAlert size={15} className="shrink-0 text-amber-600 dark:text-amber-400" />
                    )}
                    <span className="min-w-0 truncate">{profile.name}</span>
                    <span className="text-xs uppercase text-slate-400">{profile.format}</span>
                    {!profile.configured && (
                      <span className="text-xs text-amber-600 dark:text-amber-400">{t('rails.needsConfig')}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <Link
              href={'/admin/setup/payment-operations' as never}
              className="inline-flex items-center gap-1 text-sm font-medium text-teal-700 hover:underline dark:text-teal-300"
            >
              {t('rails.manageProfiles')} <ArrowUpRight size={13} />
            </Link>
          </div>
        </StepFrame>
      )}
      {data && step === 'review' && (
        <StepFrame title={t('review.title')} description={t('review.description')}>
          <div className="space-y-2 rounded-xl border border-slate-200 p-4 dark:border-slate-700">
            <div className="flex items-center justify-between py-1">
              <span className="text-sm text-slate-500 dark:text-slate-400">{t('review.packsLabel')}</span>
              <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                {[...selectedCountries].sort().join(', ') || '—'}
              </span>
            </div>
            <div className="flex items-center justify-between py-1">
              <span className="text-sm text-slate-500 dark:text-slate-400">{t('review.scheduleLabel')}</span>
              <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                {[...props.schedules.map((s) => s.name), ...(createdSchedule ? [createdSchedule.name] : [])]
                  .join(', ') || '—'}
              </span>
            </div>
          </div>
          {/* The remaining-items list IS payrollSetupState — the same checks a
              pay run's readiness pre-flight performs, localized identically. */}
          {data.setup.checks.some((check) => !check.ok) ? (
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
                {t('review.remainingTitle')}
              </p>
              <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
                {data.setup.checks.filter((check) => !check.ok).map((check, index) => (
                  <li key={`${check.code}-${index}`} className="flex items-start gap-2.5 px-4 py-2.5 text-sm">
                    <CircleAlert
                      size={16}
                      className={cn(
                        'mt-0.5 shrink-0',
                        check.severity === 'blocker'
                          ? 'text-red-600 dark:text-red-400'
                          : 'text-amber-600 dark:text-amber-400',
                      )}
                    />
                    <span className="min-w-0 flex-1 font-medium text-slate-900 dark:text-slate-100">
                      {checkLabel(check)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="flex items-center gap-2 rounded-xl border border-teal-200 bg-teal-50 px-4 py-3 text-sm text-teal-800 dark:border-teal-900 dark:bg-teal-950/40 dark:text-teal-200">
              <CheckCircle2 size={16} /> {t('review.allClear')}
            </p>
          )}
          <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">{t('review.seedNote')}</p>
        </StepFrame>
      )}
      {data && step === 'applying' && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <motion.div animate={{ rotate: 360 }} transition={{ duration: 1.2, repeat: Infinity, ease: 'linear' }}>
            <Loader2 className="text-teal-500" size={48} />
          </motion.div>
          <h2 className="mt-6 text-lg font-semibold text-slate-900 dark:text-slate-100">{t('applying.title')}</h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{t('applying.description')}</p>
        </div>
      )}
      {data && step === 'done' && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 200, damping: 12 }}>
            <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-gradient-to-br from-teal-500 to-green-500 shadow-lg shadow-teal-500/30">
              <PartyPopper className="text-white" size={36} />
            </div>
          </motion.div>
          <h2 className="mt-6 text-2xl font-bold text-slate-900 dark:text-slate-100">{t('done.title')}</h2>
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">{t('done.description')}</p>
        </div>
      )}
    </WizardShell>
  )
}

function StepFrame(props: { title: string; description: string; children: React.ReactNode }) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-bold tracking-tight text-slate-900 dark:text-slate-100">{props.title}</h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{props.description}</p>
      </div>
      {props.children}
    </div>
  )
}

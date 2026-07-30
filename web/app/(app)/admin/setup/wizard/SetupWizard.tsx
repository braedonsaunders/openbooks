'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import {
  ArrowLeft,
  ArrowRight,
  Briefcase,
  Building2,
  Calculator,
  Check,
  Cloud,
  Coins,
  Factory,
  HardHat,
  HeartHandshake,
  Home,
  Loader2,
  PartyPopper,
  Repeat,
  Ruler,
  Search,
  Sparkles,
  Stethoscope,
  Warehouse,
  X,
} from 'lucide-react'
import { cn } from '@openbooks/ui'
import type { IndustryDef } from '@/lib/industries'

// ─── Types ────────────────────────────────────────────────────────────────

type StepKey = 'welcome' | 'company' | 'industry' | 'operations' | 'review' | 'applying' | 'done'
const STEPS: StepKey[] = ['welcome', 'company', 'industry', 'operations', 'review', 'applying', 'done']

type ToggleKey = 'inventory' | 'timeTracking' | 'multiSubsidiary' | 'multiCurrency' | 'projects' | 'subscriptionBilling'

// ─── Icon map ─────────────────────────────────────────────────────────────

const INDUSTRY_ICONS: Record<string, typeof Building2> = {
  general_business: Building2,
  construction_contractor: HardHat,
  professional_services: Briefcase,
  engineering_architecture: Ruler,
  it_software_saas: Cloud,
  accounting_firm: Calculator,
  wholesale_distribution: Warehouse,
  property_management: Home,
  nonprofit: HeartHandshake,
  manufacturing: Factory,
  healthcare_practice: Stethoscope,
}

// ─── Component ────────────────────────────────────────────────────────────

export function SetupWizard(props: {
  open: boolean
  industries: IndustryDef[]
  initial: {
    name: string
    legalName: string
    country: string
    baseCurrency: string
    fiscalYearStartMonth: number
    industry: string | null
    features: Record<ToggleKey, boolean>
    allFeatures: Record<string, boolean>
  }
  canSwitchIndustry: boolean
  isRerun: boolean
  onClose?: () => void
}) {
  const t = useTranslations('admin.setup.wizard')
  const tAdmin = useTranslations('admin')
  const router = useRouter()
  const reduceMotion = useReducedMotion()
  const [stepIdx, setStepIdx] = useState(0)
  const [busy, setBusy] = useState(false)

  // Form state
  const [name, setName] = useState(props.initial.name)
  const [legalName, setLegalName] = useState(props.initial.legalName)
  const [country, setCountry] = useState(props.initial.country)
  const [currency, setCurrency] = useState(props.initial.baseCurrency)
  const [fiscalMonth, setFiscalMonth] = useState(props.initial.fiscalYearStartMonth)
  const [industryKey, setIndustryKey] = useState<string | null>(props.initial.industry)
  const [search, setSearch] = useState('')
  const [toggles, setToggles] = useState<Record<ToggleKey, boolean>>(props.initial.features)

  const step = STEPS[stepIdx]

  // When an industry is selected, prefill the toggles from its feature preset
  const selectedIndustry = useMemo(
    () => props.industries.find((i) => i.key === industryKey),
    [props.industries, industryKey],
  )

  const filteredIndustries = useMemo(() => {
    if (!search.trim()) return props.industries
    const q = search.toLowerCase()
    return props.industries.filter((i) => {
      const name = t(`industries.${i.key}.title`).toLowerCase()
      const desc = t(`industries.${i.key}.description`).toLowerCase()
      return name.includes(q) || desc.includes(q)
    })
  }, [props.industries, search, t])

  const reviewFeatureKeys = useMemo(() => {
    const effective = { ...props.initial.allFeatures }
    if (selectedIndustry && selectedIndustry.key !== props.initial.industry) {
      Object.assign(effective, selectedIndustry.features)
    }
    Object.assign(effective, toggles)
    if (!effective.projects) {
      effective.fieldTickets = false
      effective.projectScheduling = false
    }
    return Object.entries(effective)
      .filter(([, enabled]) => enabled)
      .map(([key]) => key)
      .sort((a, b) => tAdmin(`features.${a}.title`).localeCompare(tAdmin(`features.${b}.title`)))
  }, [props.initial.allFeatures, props.initial.industry, selectedIndustry, tAdmin, toggles])

  if (!props.open) return null

  // Close: if an onClose callback was provided (overlay mode), call it;
  // otherwise navigate away from the wizard page (rerun mode).
  function close() {
    if (props.onClose) {
      props.onClose()
    } else {
      router.push('/admin/setup/features')
    }
    router.refresh()
  }

  // ─── Actions ──────────────────────────────────────────────────────────

  async function skip() {
    if (props.isRerun) {
      close()
      return
    }
    setBusy(true)
    try {
      const res = await fetch('/api/admin/setup/wizard', { method: 'POST' })
      if (!res.ok) throw new Error('failed')
      close()
    } catch {
      toast.error(t('error'))
    } finally {
      setBusy(false)
    }
  }

  async function apply() {
    setBusy(true)
    setStepIdx(STEPS.indexOf('applying'))
    try {
      const res = await fetch('/api/admin/setup/wizard', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          legalName,
          country,
          baseCurrency: currency,
          fiscalYearStartMonth: fiscalMonth,
          industry: industryKey,
          features: toggles,
          skipCoa: !props.canSwitchIndustry && !!props.initial.industry,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'failed' }))
        throw new Error(err.error ?? 'failed')
      }
      // Show the done step briefly, then close
      setStepIdx(STEPS.indexOf('done'))
      setTimeout(() => {
        close()
      }, 2500)
    } catch (e) {
      toast.error((e as Error).message)
      setStepIdx(STEPS.indexOf('review'))
    } finally {
      setBusy(false)
    }
  }

  function next() {
    if (stepIdx < STEPS.indexOf('review')) setStepIdx((s) => s + 1)
  }
  function back() {
    if (stepIdx > 0) setStepIdx((s) => s - 1)
  }

  // When user picks an industry, update toggles from its preset (only keys it has opinions about)
  function pickIndustry(key: string) {
    setIndustryKey(key)
    const ind = props.industries.find((i) => i.key === key)
    if (ind) {
      setToggles((prev) => ({
        ...prev,
        inventory: ind.features.inventory ?? prev.inventory,
        timeTracking: ind.features.timeTracking ?? prev.timeTracking,
        multiSubsidiary: ind.features.multiSubsidiary ?? prev.multiSubsidiary,
        multiCurrency: ind.features.multiCurrency ?? prev.multiCurrency,
        projects: ind.features.projects ?? prev.projects,
        subscriptionBilling: ind.features.subscriptionBilling ?? prev.subscriptionBilling,
      }))
    }
  }

  const canNext =
    step === 'company' ? name.trim().length > 0 : step === 'industry' ? industryKey !== null : true

  const progressSteps = STEPS.slice(1, 5) // company → industry → operations → review
  const progressIdx = Math.max(0, stepIdx - 1)

  // ─── Render ───────────────────────────────────────────────────────────

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/80 backdrop-blur-sm"
      >
        {/* Close/skip button */}
        {!busy && step !== 'applying' && step !== 'done' && (
          <button
            type="button"
            onClick={skip}
            className="absolute right-6 top-6 z-10 flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-slate-300 transition-colors hover:bg-white/10 hover:text-white"
          >
            <X size={16} /> {t('skip')}
          </button>
        )}

        <motion.div
          initial={reduceMotion ? false : { scale: 0.95, y: 10 }}
          animate={{ scale: 1, y: 0 }}
          transition={{ type: 'spring', stiffness: 300, damping: 30 }}
          className="relative flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-slate-900"
        >
          {/* Progress bar */}
          {stepIdx > 0 && stepIdx < STEPS.indexOf('applying') && (
            <div className="flex items-center gap-2 px-6 pt-5">
              {progressSteps.map((s, i) => (
                <div
                  key={s}
                  className={cn(
                    'h-1.5 flex-1 rounded-full transition-colors duration-300',
                    i < progressIdx
                      ? 'bg-teal-500'
                      : i === progressIdx
                        ? 'bg-teal-500'
                        : 'bg-slate-200 dark:bg-slate-700',
                  )}
                />
              ))}
            </div>
          )}

          {/* Step content (scrollable) */}
          <div className="flex-1 overflow-y-auto px-6 py-6 sm:px-10 sm:py-8">
            <AnimatePresence mode="wait">
              <motion.div
                key={step}
                initial={reduceMotion ? false : { opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={reduceMotion ? undefined : { opacity: 0, x: -20 }}
                transition={{ duration: 0.25 }}
              >
                {step === 'welcome' && <WelcomeStep t={t} />}
                {step === 'company' && (
                  <CompanyStep
                    t={t}
                    name={name}
                    legalName={legalName}
                    country={country}
                    currency={currency}
                    fiscalMonth={fiscalMonth}
                    setName={setName}
                    setLegalName={setLegalName}
                    setCountry={setCountry}
                    setCurrency={setCurrency}
                    setFiscalMonth={setFiscalMonth}
                  />
                )}
                {step === 'industry' && (
                  <IndustryStep
                    t={t}
                    industries={filteredIndustries}
                    selected={industryKey}
                    search={search}
                    setSearch={setSearch}
                    onPick={pickIndustry}
                    canSwitch={props.canSwitchIndustry}
                    currentIndustry={props.initial.industry}
                  />
                )}
                {step === 'operations' && (
                  <OperationsStep t={t} toggles={toggles} setToggles={setToggles} />
                )}
                {step === 'review' && (
                  <ReviewStep
                    t={t}
                    name={name}
                    country={country}
                    currency={currency}
                    industry={selectedIndustry}
                    featureKeys={reviewFeatureKeys}
                    featureTitle={(key) => tAdmin(`features.${key}.title`)}
                  />
                )}
                {step === 'applying' && <ApplyingStep t={t} />}
                {step === 'done' && <DoneStep t={t} />}
              </motion.div>
            </AnimatePresence>
          </div>

          {/* Footer navigation */}
          {stepIdx < STEPS.indexOf('applying') && stepIdx < STEPS.indexOf('done') && (
            <div className="flex items-center justify-between border-t border-slate-200 px-6 py-4 dark:border-slate-800 sm:px-10">
              {stepIdx > 0 ? (
                <button
                  type="button"
                  onClick={back}
                  disabled={busy}
                  className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 disabled:opacity-50 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  <ArrowLeft size={16} /> {t('back')}
                </button>
              ) : (
                <span aria-hidden="true" />
              )}
              {step === 'review' ? (
                <button
                  type="button"
                  onClick={apply}
                  disabled={busy}
                  className="flex items-center gap-2 rounded-lg bg-teal-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-teal-700 disabled:opacity-50"
                >
                  <Sparkles size={16} /> {t('apply')}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={next}
                  disabled={!canNext || busy}
                  className="flex items-center gap-1.5 rounded-lg bg-teal-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {t('next')} <ArrowRight size={16} />
                </button>
              )}
            </div>
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}

// ─── Steps ────────────────────────────────────────────────────────────────

function WelcomeStep({ t }: { t: ReturnType<typeof useTranslations<'admin.setup.wizard'>> }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <motion.div
        initial={{ scale: 0, rotate: -20 }}
        animate={{ scale: 1, rotate: 0 }}
        transition={{ type: 'spring', stiffness: 200, damping: 15, delay: 0.1 }}
        className="mb-6 flex h-20 w-20 items-center justify-center rounded-2xl bg-gradient-to-br from-teal-500 to-cyan-600 shadow-lg shadow-teal-500/30"
      >
        <Sparkles className="text-white" size={36} />
      </motion.div>
      <h2 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
        {t('welcome.title')}
      </h2>
      <p className="mt-3 max-w-md text-sm leading-relaxed text-slate-500 dark:text-slate-400">
        {t('welcome.description')}
      </p>
      <div className="mt-8 grid grid-cols-3 gap-4 text-center">
        {(['welcome.f1', 'welcome.f2', 'welcome.f3'] as const).map((k, i) => (
          <motion.div
            key={k}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 + i * 0.1 }}
            className="rounded-lg border border-slate-200 p-3 dark:border-slate-700"
          >
            <p className="text-xs font-medium text-slate-700 dark:text-slate-200">{t(k)}</p>
          </motion.div>
        ))}
      </div>
    </div>
  )
}

function CompanyStep(props: {
  t: ReturnType<typeof useTranslations<'admin.setup.wizard'>>
  name: string
  legalName: string
  country: string
  currency: string
  fiscalMonth: number
  setName: (v: string) => void
  setLegalName: (v: string) => void
  setCountry: (v: string) => void
  setCurrency: (v: string) => void
  setFiscalMonth: (v: number) => void
}) {
  const { t, name, legalName, country, currency, fiscalMonth } = props
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
          {t('company.title')}
        </h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{t('company.description')}</p>
      </div>
      <div className="space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">
            {t('company.name')}
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => props.setName(e.target.value)}
            placeholder={t('company.namePlaceholder')}
            className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
            autoFocus
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">
            {t('company.legalName')}
          </label>
          <input
            type="text"
            value={legalName}
            onChange={(e) => props.setLegalName(e.target.value)}
            placeholder={t('company.legalNamePlaceholder')}
            className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">
              {t('company.country')}
            </label>
            <input
              type="text"
              value={country}
              onChange={(e) => props.setCountry(e.target.value)}
              maxLength={2}
              className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm uppercase text-slate-900 placeholder:text-slate-400 focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">
              {t('company.currency')}
            </label>
            <input
              type="text"
              value={currency}
              onChange={(e) => props.setCurrency(e.target.value.toUpperCase())}
              maxLength={3}
              className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm uppercase text-slate-900 placeholder:text-slate-400 focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
            />
          </div>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">
            {t('company.fiscalYear')}
          </label>
          <select
            value={fiscalMonth}
            onChange={(e) => props.setFiscalMonth(Number(e.target.value))}
            className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-900 focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          >
            {['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].map(
              (m, i) => (
                <option key={m} value={i + 1}>
                  {m}
                </option>
              ),
            )}
          </select>
        </div>
      </div>
    </div>
  )
}

function IndustryStep(props: {
  t: ReturnType<typeof useTranslations<'admin.setup.wizard'>>
  industries: IndustryDef[]
  selected: string | null
  search: string
  setSearch: (v: string) => void
  onPick: (key: string) => void
  canSwitch: boolean
  currentIndustry: string | null
}) {
  const { t, industries, selected, search, setSearch, onPick, canSwitch, currentIndustry } = props
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
          {t('industry.title')}
        </h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{t('industry.description')}</p>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('industry.search')}
          className="w-full rounded-lg border border-slate-300 py-2.5 pl-10 pr-4 text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
        />
      </div>

      {/* Industry grid */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {industries.map((ind, i) => {
          const Icon = INDUSTRY_ICONS[ind.key] ?? Building2
          const isSelected = selected === ind.key
          const isLocked = !canSwitch && currentIndustry !== ind.key
          return (
            <motion.button
              key={ind.key}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: Math.min(i * 0.03, 0.3) }}
              whileHover={!isLocked ? { scale: 1.02 } : undefined}
              whileTap={!isLocked ? { scale: 0.98 } : undefined}
              type="button"
              disabled={isLocked}
              onClick={() => !isLocked && onPick(ind.key)}
              className={cn(
                'relative flex items-start gap-3 rounded-xl border p-4 text-left transition-colors',
                isSelected
                  ? 'border-teal-500 bg-teal-50 ring-2 ring-teal-500/20 dark:border-teal-400 dark:bg-teal-950/40'
                  : isLocked
                    ? 'cursor-not-allowed border-slate-200 bg-slate-50 opacity-50 dark:border-slate-800 dark:bg-slate-800/50'
                    : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800/60',
              )}
            >
              <div
                className={cn(
                  'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg transition-colors',
                  isSelected
                    ? 'bg-teal-500 text-white'
                    : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
                )}
              >
                <Icon size={20} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {t(`industries.${ind.key}.title`)}
                </p>
                <p className="mt-0.5 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                  {t(`industries.${ind.key}.description`)}
                </p>
              </div>
              {isSelected && (
                <motion.div
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ type: 'spring', stiffness: 300, damping: 20 }}
                  className="absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded-full bg-teal-500"
                >
                  <Check className="text-white" size={12} strokeWidth={3} />
                </motion.div>
              )}
            </motion.button>
          )
        })}
      </div>

      {!canSwitch && currentIndustry && (
        <p className="text-center text-xs text-amber-600 dark:text-amber-400">
          {t('industry.locked')}
        </p>
      )}
    </div>
  )
}

function OperationsStep(props: {
  t: ReturnType<typeof useTranslations<'admin.setup.wizard'>>
  toggles: Record<ToggleKey, boolean>
  setToggles: React.Dispatch<React.SetStateAction<Record<ToggleKey, boolean>>>
}) {
  const { t, toggles, setToggles } = props
  const items: { key: ToggleKey; icon: typeof Building2 }[] = [
    { key: 'projects', icon: Briefcase },
    { key: 'timeTracking', icon: Check },
    { key: 'inventory', icon: Warehouse },
    { key: 'subscriptionBilling', icon: Repeat },
    { key: 'multiSubsidiary', icon: Building2 },
    { key: 'multiCurrency', icon: Coins },
  ]

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
          {t('operations.title')}
        </h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{t('operations.description')}</p>
      </div>
      <div className="space-y-3">
        {items.map(({ key, icon: Icon }) => (
          <ToggleRow
            key={key}
            icon={<Icon size={18} />}
            label={t(`operations.${key}.title`)}
            description={t(`operations.${key}.description`)}
            on={toggles[key]}
            onToggle={() => setToggles((previous) => {
              const next = { ...previous, [key]: !previous[key] }
              if (key === 'projects' && !next.projects) next.timeTracking = false
              if (key === 'timeTracking' && next.timeTracking) next.projects = true
              return next
            })}
          />
        ))}
      </div>
      <p className="rounded-lg bg-slate-50 p-3 text-xs text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
        {t('operations.note')}
      </p>
    </div>
  )
}

function ToggleRow(props: {
  icon: React.ReactNode
  label: string
  description: string
  on: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={props.onToggle}
      className={cn(
        'flex w-full items-center gap-3 rounded-xl border p-3.5 text-left transition-colors',
        props.on
          ? 'border-teal-500 bg-teal-50 dark:border-teal-400 dark:bg-teal-950/40'
          : 'border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800/60',
      )}
    >
      <div
        className={cn(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
          props.on ? 'bg-teal-500 text-white' : 'bg-slate-100 text-slate-400 dark:bg-slate-800',
        )}
      >
        {props.icon}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{props.label}</p>
        <p className="text-xs text-slate-500 dark:text-slate-400">{props.description}</p>
      </div>
      <div
        className={cn(
          'relative h-6 w-11 shrink-0 rounded-full transition-colors',
          props.on ? 'bg-teal-600' : 'bg-slate-300 dark:bg-slate-700',
        )}
      >
        <motion.div
          className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm"
          animate={{ x: props.on ? 22 : 2 }}
          transition={{ type: 'spring', stiffness: 500, damping: 30 }}
        />
      </div>
    </button>
  )
}

function ReviewStep(props: {
  t: ReturnType<typeof useTranslations<'admin.setup.wizard'>>
  name: string
  country: string
  currency: string
  industry?: IndustryDef
  featureKeys: string[]
  featureTitle: (key: string) => string
}) {
  const { t, name, country, currency, industry, featureKeys, featureTitle } = props
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
          {t('review.title')}
        </h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{t('review.description')}</p>
      </div>
      <div className="space-y-2 rounded-xl border border-slate-200 p-4 dark:border-slate-700">
        <ReviewRow label={t('review.companyName')} value={name} />
        <ReviewRow label={t('review.country')} value={country.toUpperCase()} />
        <ReviewRow label={t('review.currency')} value={currency} />
        {industry && (
          <>
            <ReviewRow label={t('review.industry')} value={t(`industries.${industry.key}.title`)} />
            <ReviewRow
              label={t('review.chartOfAccounts')}
              value={`${industry.coa.length} ${t('review.accounts')}`}
            />
          </>
        )}
      </div>
      {featureKeys.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
            {t('review.features')}
          </p>
          <div className="flex flex-wrap gap-2">
            {featureKeys.map((key) => (
              <span
                key={key}
                className="rounded-full bg-teal-50 px-3 py-1 text-xs font-medium text-teal-700 dark:bg-teal-950/40 dark:text-teal-300"
              >
                {featureTitle(key)}
              </span>
            ))}
          </div>
        </div>
      )}
      <p className="text-xs text-slate-400 dark:text-slate-500">{t('review.note')}</p>
    </div>
  )
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-sm text-slate-500 dark:text-slate-400">{label}</span>
      <span className="text-sm font-medium text-slate-900 dark:text-slate-100">{value}</span>
    </div>
  )
}

function ApplyingStep({ t }: { t: ReturnType<typeof useTranslations<'admin.setup.wizard'>> }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <motion.div
        animate={{ rotate: 360 }}
        transition={{ duration: 1.2, repeat: Infinity, ease: 'linear' }}
      >
        <Loader2 className="text-teal-500" size={48} />
      </motion.div>
      <h2 className="mt-6 text-lg font-semibold text-slate-900 dark:text-slate-100">
        {t('applying.title')}
      </h2>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{t('applying.description')}</p>
    </div>
  )
}

function DoneStep({ t }: { t: ReturnType<typeof useTranslations<'admin.setup.wizard'>> }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <motion.div
        initial={{ scale: 0 }}
        animate={{ scale: 1 }}
        transition={{ type: 'spring', stiffness: 200, damping: 12 }}
      >
        <motion.div
          initial={{ rotate: -15 }}
          animate={{ rotate: 0 }}
          transition={{ type: 'spring', stiffness: 200, damping: 8, delay: 0.1 }}
          className="flex h-20 w-20 items-center justify-center rounded-2xl bg-gradient-to-br from-teal-500 to-green-500 shadow-lg shadow-teal-500/30"
        >
          <PartyPopper className="text-white" size={36} />
        </motion.div>
      </motion.div>
      <motion.h2
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
        className="mt-6 text-2xl font-bold text-slate-900 dark:text-slate-100"
      >
        {t('done.title')}
      </motion.h2>
      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.5 }}
        className="mt-2 text-sm text-slate-500 dark:text-slate-400"
      >
        {t('done.description')}
      </motion.p>
    </div>
  )
}

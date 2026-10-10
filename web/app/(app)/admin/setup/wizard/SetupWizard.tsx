'use client'

import { useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { motion, useReducedMotion } from 'framer-motion'
import { WizardShell } from './WizardShell'
import {
  ArrowLeft,
  ArrowRight,
  BarChart3,
  Briefcase,
  Building2,
  Boxes,
  Calculator,
  CalendarRange,
  Check,
  Cloud,
  Coins,
  CreditCard,
  Download,
  Factory,
  HardHat,
  HeartHandshake,
  Home,
  Landmark,
  Loader2,
  PartyPopper,
  Repeat,
  Ruler,
  Search,
  SlidersHorizontal,
  ShieldCheck,
  Sparkles,
  Stethoscope,
  Users,
  Wallet,
  Warehouse,
} from 'lucide-react'
import { cn } from '@openbooks/ui'
import type { IndustryDef } from '@/lib/industries'
import { countryOptions } from '@/lib/countries'
import { currencyOptions } from '@/lib/iso-currencies'
import { enterOrg } from '@/lib/sandbox-session'
import { readApiErrorMessage } from '@/lib/api-error'
import {
  recommendWorkspaceFeatures,
  type ComplexityLevel,
  type BookStart,
  type CloseCadence,
  type MonthlyActivityLevel,
  type TaxPosition,
  type TeamSize,
  type WorkspaceProfile,
} from '@/lib/workspace-profile'
import { initialPayrollPack, packDescription, packTitle, type WizardPayrollPack, type WizardT } from './payroll-pack-display'
import type { SetupLaunchAction } from '@/lib/setup-launch-actions'
import { MIGRATION_WORKSPACE_HREF } from '@/lib/migration/links'
import { defaultBusinessTimeZone, type CountryTimeZoneDirectory } from './time-zone-default'
import { NEUTRAL_INDUSTRY_KEY } from '@/lib/industry-keys'
import { effectiveFeatureState, type FeatureTreeRow } from '../features/feature-tree'
import { FeatureChoiceStep } from './FeatureChoiceStep'
import { searchIndustries } from './industry-search'
import { documentCreateHref } from '@/lib/document-kinds'

// ─── Types ────────────────────────────────────────────────────────────────

type StepKey = 'welcome' | 'company' | 'industry' | 'profile' | 'rhythm' | 'operations' | 'features' | 'payroll' | 'launch' | 'review' | 'applying' | 'done'

/** How the company's features are chosen: from an industry preset (the
 *  Operations step), or individually on the switchboard when no preset fits. */
type FeatureSelection = 'industry' | 'custom'
const BASE_STEPS: StepKey[] = ['welcome', 'company', 'industry', 'profile', 'rhythm', 'operations', 'launch', 'review', 'applying', 'done']

type ToggleKey = 'inventory' | 'timeTracking' | 'multiSubsidiary' | 'multiCurrency' | 'projects' | 'subscriptionBilling' | 'orders' | 'crm' | 'bankFeeds' | 'onlinePayments' | 'fixedAssets' | 'payroll'

/**
 * The payroll country pack the org will install — an open string over the
 * packs the server declares via the `payrollPacks` prop, never a closed
 * union. Null means the operator has not chosen (or chose none).
 */
type PayrollPack = string | null

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

/** The operator's own zone for a fresh org's default: the browser's
 *  resolved zone, UTC when the runtime cannot tell. The server validates
 *  and canonicalizes whatever the company step sends. */
function browserTimeZone(locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale).resolvedOptions().timeZone ?? 'UTC'
  } catch {
    return 'UTC'
  }
}

// ─── Component ────────────────────────────────────────────────────────────

export function SetupWizard(props: {
  launchActions?: SetupLaunchAction[]
  open: boolean
  industries: IndustryDef[]
  initial: {
    name: string
    legalName: string
    country: string
    baseCurrency: string
    fiscalYearStartMonth: number
    /** Stored effective business time zone (canonical), or null when the
     *  org never set one — the company step then defaults to the browser
     *  zone so a fresh org days on its own calendar from day one. */
    timeZone: string | null
    industry: string | null
    workspaceProfile: WorkspaceProfile
    /** How the stored features were chosen, when setup ran before. */
    featureSelection?: FeatureSelection
    features: Record<ToggleKey, boolean>
    allFeatures: Record<string, boolean>
  }
  /** The feature registry as a tree (category, parent, requirements,
   *  recommendations) — the same rows Company Settings → Features renders. */
  featureRows: FeatureTreeRow[]
  canSwitchIndustry: boolean
  isRerun: boolean
  suppressOnWizardRoute?: boolean
  /** HR-15: routes the overlay never covers (the inbox stays workable
   *  while onboarding is pending — setup remains one nav click away). */
  suppressOnPaths?: readonly string[]
  /** Installable payroll country packs, in registry order — declared by the
   *  server from the pack registry, never a list in this file. */
  payrollPacks?: WizardPayrollPack[]
  /** Canonical IANA zone names for the business-time-zone picker — declared
   *  by the server from the shared platform validator, never a list here. */
  timeZones: string[]
  /** Zones and representative zone per country, from the engine's runtime
   *  directory — the company step defaults the zone from the country. */
  countryTimeZones: CountryTimeZoneDirectory
  onClose?: () => void
}) {
  const locale = useLocale()
  const t = useTranslations('admin.setup.wizard')
  const tAdmin = useTranslations('admin')
  const router = useRouter()
  const pathname = usePathname()
  const reduceMotion = useReducedMotion()
  const [stepIdx, setStepIdx] = useState(0)
  const [busy, setBusy] = useState(false)
  const [transitioning, setTransitioning] = useState(false)
  const stepTransitionLocked = useRef(false)

  // Form state
  const [name, setName] = useState(props.initial.name)
  const [legalName, setLegalName] = useState(props.initial.legalName)
  const [country, setCountry] = useState(props.initial.country)
  const [currency, setCurrency] = useState(props.initial.baseCurrency)
  const [fiscalMonth, setFiscalMonth] = useState(props.initial.fiscalYearStartMonth)
  const offeredTimeZones = useMemo(() => new Set(props.timeZones), [props.timeZones])
  // The zone a company in `forCountry` starts on: the operator's browser zone
  // when it belongs to that country, else the country's representative zone.
  const countryDefaultTimeZone = (forCountry: string) => defaultBusinessTimeZone({
    country: forCountry,
    browserZone: browserTimeZone(locale),
    directory: props.countryTimeZones,
    offered: offeredTimeZones,
  })
  // A stored zone, or one the operator picked here, is a decision; until
  // then the zone follows the chosen country.
  const [timeZoneChosen, setTimeZoneChosen] = useState(
    () => Boolean(props.initial.timeZone && offeredTimeZones.has(props.initial.timeZone)),
  )
  const [timeZone, setTimeZone] = useState(() => {
    // The select can only offer the server's canonical list: a stored zone
    // from a richer ICU falls back to the country default rather than
    // rendering a blank selection.
    if (props.initial.timeZone && offeredTimeZones.has(props.initial.timeZone)) return props.initial.timeZone
    return countryDefaultTimeZone(props.initial.country)
  })
  const [industryKey, setIndustryKey] = useState<string | null>(props.initial.industry)
  const [featureMode, setFeatureMode] = useState<FeatureSelection>(
    props.initial.featureSelection === 'custom' && props.initial.industry === NEUTRAL_INDUSTRY_KEY ? 'custom' : 'industry',
  )
  // A re-run of a custom setup opens on the stored choices, which are
  // already the operator's own.
  const [customFeaturesChosen, setCustomFeaturesChosen] = useState(featureMode === 'custom')
  const [teamSize, setTeamSize] = useState<TeamSize>(props.initial.workspaceProfile.teamSize)
  const [complexity, setComplexity] = useState<ComplexityLevel>(props.initial.workspaceProfile.complexity)
  const [configureRhythm, setConfigureRhythm] = useState(false)
  const [bookStart, setBookStart] = useState<BookStart>(props.initial.workspaceProfile.bookStart)
  const [taxPosition, setTaxPosition] = useState<TaxPosition>(props.initial.workspaceProfile.taxPosition)
  const [monthlyActivity, setMonthlyActivity] = useState<MonthlyActivityLevel>(props.initial.workspaceProfile.monthlyActivity)
  const [closeCadence, setCloseCadence] = useState<CloseCadence>(props.initial.workspaceProfile.closeCadence)
  const [search, setSearch] = useState('')
  const [toggles, setToggles] = useState<Record<ToggleKey, boolean>>(props.initial.features)
  const [featureChoices, setFeatureChoices] = useState<Record<string, boolean>>(props.initial.allFeatures)
  const [includeSampleCompany, setIncludeSampleCompany] = useState(false)
  const [sampleOrgId, setSampleOrgId] = useState<string | null>(null)
  const installablePacks = props.payrollPacks ?? []
  const [payrollPack, setPayrollPack] = useState<PayrollPack>(initialPayrollPack(installablePacks))
  const countries = useMemo(() => countryOptions(locale), [locale])
  const currencies = useMemo(() => currencyOptions(locale), [locale])
  // Fiscal months render in the operator's locale — a hardcoded English list
  // would state the wrong selected value to every non-English reviewer.
  const fiscalMonths = useMemo(() => {
    const format = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' })
    return Array.from({ length: 12 }, (_, index) => ({
      value: index + 1,
      label: format.format(new Date(Date.UTC(2026, index, 1))),
    }))
  }, [locale])

  // Every choice resolved through the registry tree: a child of an off parent
  // (Field Tickets under Projects) is off, as the Features switchboard shows it.
  const effectiveFeatures = useMemo(
    () => effectiveFeatureState(props.featureRows, { ...featureChoices, ...toggles }),
    [featureChoices, props.featureRows, toggles],
  )
  const payrollOn = featureMode === 'custom' ? Boolean(effectiveFeatures.payroll) : toggles.payroll

  // The Payroll step only exists when the module is switched on — it is an
  // optional module step, inserted after Operations where it was enabled.
  // Choosing features individually replaces Operations with the switchboard.
  const steps = useMemo<StepKey[]>(
    () => BASE_STEPS
      .filter((key) => key !== 'rhythm' || complexity !== 'essentials' || configureRhythm)
      .map((key): StepKey => key === 'operations' && featureMode === 'custom' ? 'features' : key)
      .flatMap((key): StepKey[] => (key === 'operations' || key === 'features') && payrollOn ? [key, 'payroll'] : [key]),
    [payrollOn, complexity, configureRhythm, featureMode],
  )

  const step = steps[stepIdx]!

  // When an industry is selected, prefill the toggles from its feature preset
  const selectedIndustry = useMemo(
    () => props.industries.find((i) => i.key === industryKey),
    [props.industries, industryKey],
  )

  // Titles, descriptions and localized keywords ("café", "retail",
  // "e-commerce") all find a preset, so a business the preset names fits.
  const filteredIndustries = useMemo(
    () => searchIndustries(props.industries, search, (key) => ({
      title: t(`industries.${key}.title`),
      description: t(`industries.${key}.description`),
      keywords: t.has(`industries.${key}.keywords` as never) ? t(`industries.${key}.keywords` as never) : '',
    })),
    [props.industries, search, t],
  )

  const reviewFeatureKeys = useMemo(
    () => Object.entries(effectiveFeatures)
      .filter(([, enabled]) => enabled)
      .map(([key]) => key)
      .sort((a, b) => tAdmin(`features.${a}.title`).localeCompare(tAdmin(`features.${b}.title`))),
    [effectiveFeatures, tAdmin],
  )

  if (!props.open || (props.suppressOnWizardRoute && pathname === '/admin/setup/wizard')) return null
  // HR-15: work waiting on the user stays reachable while onboarding pends.
  if (props.suppressOnPaths?.some((path) => pathname === path || pathname.startsWith(`${path}/`))) return null

  // Close: if an onClose callback was provided (overlay mode), call it;
  // otherwise navigate away from the wizard page (rerun mode).
  function close() {
    if (props.onClose) {
      props.onClose()
    } else {
      router.push('/admin/setup/readiness')
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
      if (!res.ok) throw new Error(await readApiErrorMessage(res, t('error')))
      // Skipping is a deferral, not an abandonment: land on the canonical
      // home and name where setup resumes, instead of detouring into Setup.
      toast.success(t('skipped'))
      router.push('/dashboard')
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : t('error'))
    } finally {
      setBusy(false)
    }
  }

  async function apply() {
    if (stepTransitionLocked.current) return
    setBusy(true)
    setStepIdx(steps.indexOf('applying'))
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
          timeZone,
          industry: industryKey,
          workspaceProfile: { teamSize, complexity, bookStart, taxPosition, monthlyActivity, closeCadence },
          // Choosing individually submits the resolved switchboard state, so
          // every child of an off parent travels as off.
          features: featureMode === 'custom' ? effectiveFeatures : { ...featureChoices, ...toggles },
          featureSelection: featureMode,
        }),
      })
      if (!res.ok) {
        // A refusal's sentence wins over its code; a body that is not JSON
        // keeps the localized fallback.
        const err = await res.json().catch(() => null) as { error?: unknown; message?: unknown } | null
        throw new Error(
          typeof err?.message === 'string' && err.message.trim()
            ? err.message
            : typeof err?.error === 'string' && err.error.trim() ? err.error : t('error'),
        )
      }
      // Payroll module chosen with a country pack: install it now (statutory
      // component seed + pack marker), mirroring the sample-company follow-up.
      // The pack is whatever the operator chose — the settings API refuses
      // anything outside the registry's installable set.
      if (payrollOn && payrollPack) {
        const pack = await fetch('/api/payroll/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'install-pack', country: payrollPack }),
        })
        if (!pack.ok) {
          throw new Error(await readApiErrorMessage(pack, t('payroll.installError')))
        }
      }
      if (includeSampleCompany && industryKey) {
        const sample = await fetch('/api/data/sample-companies', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ industry: industryKey }),
        })
        if (!sample.ok) {
          const detail = await sample.clone().json().catch(() => null) as { message?: unknown } | null
          throw new Error(
            typeof detail?.message === 'string' && detail.message.trim()
              ? detail.message
              : await readApiErrorMessage(sample, t('launch.sample.error')),
          )
        }
        const installed = await sample.json() as { orgId?: unknown }
        if (typeof installed.orgId !== 'string') throw new Error(t('launch.sample.error'))
        setSampleOrgId(installed.orgId)
      }
      // Keep the next action available until the operator chooses a destination.
      setStepIdx(steps.indexOf('done'))
    } catch (e) {
      toast.error((e as Error).message)
      setStepIdx(steps.indexOf('review'))
    } finally {
      setBusy(false)
    }
  }

  function moveStep(delta: -1 | 1) {
    // AnimatePresence keeps the outgoing content mounted for its exit
    // animation. Guard the state transition synchronously so a double-click
    // cannot advance the newly selected step while the old step is visible.
    if (stepTransitionLocked.current) return
    stepTransitionLocked.current = true
    setTransitioning(true)
    setStepIdx((current) => Math.max(0, Math.min(steps.indexOf('review'), current + delta)))
    window.setTimeout(() => {
      stepTransitionLocked.current = false
      setTransitioning(false)
    }, reduceMotion ? 120 : 300)
  }

  function next() {
    if (stepIdx < steps.indexOf('review')) moveStep(1)
  }
  function back() {
    if (stepIdx > 0) moveStep(-1)
  }

  // When user picks an industry, update toggles from its preset (only keys it has opinions about)
  function pickIndustry(key: string) {
    setIndustryKey(key)
    setFeatureMode('industry')
    setCustomFeaturesChosen(false)
    const ind = props.industries.find((i) => i.key === key)
    if (ind) {
      applyRecommendation({ teamSize, complexity, bookStart, taxPosition, monthlyActivity, closeCadence }, ind, true)
    }
  }

  /** No preset fits: the neutral base chart, with features chosen on the
   *  switchboard. The profile's recommendation is only a starting point. */
  function chooseOwnFeatures() {
    setIndustryKey(NEUTRAL_INDUSTRY_KEY)
    setFeatureMode('custom')
    setCustomFeaturesChosen(false)
    applyRecommendation(
      { teamSize, complexity, bookStart, taxPosition, monthlyActivity, closeCadence },
      props.industries.find((industry) => industry.key === NEUTRAL_INDUSTRY_KEY),
      true,
    )
  }

  /** One switchboard choice in the "pick my own features" step. */
  function chooseFeature(key: string, value: boolean) {
    setCustomFeaturesChosen(true)
    setFeatureChoices((current) => ({ ...current, [key]: value }))
    if (key in toggles) setToggles((current) => ({ ...current, [key]: value }))
  }

  function applyRecommendation(profile: WorkspaceProfile, industry = selectedIndustry, force = false) {
    // Once the operator has picked features individually, later profile
    // answers never overwrite those picks.
    if (!force && featureMode === 'custom' && customFeaturesChosen) return
    const recommended = recommendWorkspaceFeatures({
      featureKeys: Object.keys(props.initial.allFeatures),
      industryFeatures: industry?.features,
      profile,
    })
    setFeatureChoices(recommended)
    setToggles({
      inventory: recommended.inventory ?? false,
      timeTracking: recommended.timeTracking ?? false,
      multiSubsidiary: recommended.multiSubsidiary ?? false,
      multiCurrency: recommended.multiCurrency ?? false,
      projects: recommended.projects ?? false,
      subscriptionBilling: recommended.subscriptionBilling ?? false,
      orders: recommended.orders ?? false,
      crm: recommended.crm ?? false,
      bankFeeds: recommended.bankFeeds ?? false,
      onlinePayments: recommended.onlinePayments ?? false,
      fixedAssets: recommended.fixedAssets ?? false,
      payroll: recommended.payroll ?? false,
    })
  }

  function chooseTeamSize(value: TeamSize) {
    setTeamSize(value)
    applyRecommendation({ teamSize: value, complexity, bookStart, taxPosition, monthlyActivity, closeCadence })
  }

  function chooseComplexity(value: ComplexityLevel) {
    setComplexity(value)
    applyRecommendation({ teamSize, complexity: value, bookStart, taxPosition, monthlyActivity, closeCadence })
  }

  function chooseMonthlyActivity(value: MonthlyActivityLevel) {
    setMonthlyActivity(value)
    applyRecommendation({ teamSize, complexity, bookStart, taxPosition, monthlyActivity: value, closeCadence })
  }

  function chooseCloseCadence(value: CloseCadence) {
    setCloseCadence(value)
    applyRecommendation({ teamSize, complexity, bookStart, taxPosition, monthlyActivity, closeCadence: value })
  }

  const canNext =
    step === 'company' ? name.trim().length > 0 : step === 'industry' ? industryKey !== null : true

  const progressSteps = steps.slice(1, steps.indexOf('applying')) // company → … → review
  const progressIdx = Math.max(0, stepIdx - 1)

  // ─── Render ───────────────────────────────────────────────────────────

  return (
    <WizardShell
      testId="setup-wizard"
      dialogLabel={t('welcome.title')}
      stepKey={step}
      progress={
        stepIdx > 0 && stepIdx < steps.indexOf('applying')
          ? { index: progressIdx, total: progressSteps.length }
          : null
      }
      skip={
        !busy && step !== 'applying' && step !== 'done'
          ? { label: t('skip'), onClick: skip, disabled: transitioning }
          : null
      }
      footer={
        stepIdx < steps.indexOf('applying')
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
                          <Sparkles size={16} /> {t('apply')}
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
      {step === 'welcome' && <WelcomeStep t={t} />}
      {step === 'company' && (
        <CompanyStep
          t={t}
          name={name}
          legalName={legalName}
          country={country}
          currency={currency}
          fiscalMonth={fiscalMonth}
          timeZone={timeZone}
          countries={countries}
          currencies={currencies}
          months={fiscalMonths}
          timeZones={props.timeZones}
          setName={setName}
          setLegalName={setLegalName}
          setCountry={(value) => {
            setCountry(value)
            if (!timeZoneChosen) setTimeZone(countryDefaultTimeZone(value))
          }}
          setCurrency={setCurrency}
          setFiscalMonth={setFiscalMonth}
          setTimeZone={(value) => {
            setTimeZone(value)
            setTimeZoneChosen(true)
          }}
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
          customSelected={featureMode === 'custom'}
          onPickCustom={chooseOwnFeatures}
          canSwitch={props.canSwitchIndustry}
          currentIndustry={props.initial.industry}
        />
      )}
      {step === 'profile' && (
        <ProfileStep
          t={t}
          teamSize={teamSize}
          complexity={complexity}
          onTeamSize={chooseTeamSize}
          onComplexity={chooseComplexity}
        />
      )}
      {step === 'rhythm' && (
        <RhythmStep
          t={t}
          monthlyActivity={monthlyActivity}
          closeCadence={closeCadence}
          onMonthlyActivity={chooseMonthlyActivity}
          onCloseCadence={chooseCloseCadence}
        />
      )}
      {step === 'operations' && (
        <OperationsStep
          t={t}
          toggles={toggles}
          setToggles={(update) => {
            setToggles((previous) => {
              const next = typeof update === 'function' ? update(previous) : update
              setFeatureChoices((features) => ({ ...features, ...next }))
              return next
            })
          }}
        />
      )}
      {step === 'features' && (
        <FeatureChoiceStep
          rows={props.featureRows}
          state={{ ...featureChoices, ...toggles }}
          onToggle={chooseFeature}
        />
      )}
      {step === 'payroll' && (
        <PayrollStep t={t} packs={installablePacks} pack={payrollPack} setPack={setPayrollPack} />
      )}
      {step === 'launch' && (
        <LaunchStep
          t={t}
          bookStart={bookStart}
          taxPosition={taxPosition}
          includeSampleCompany={includeSampleCompany}
          setBookStart={setBookStart}
          setTaxPosition={setTaxPosition}
          setIncludeSampleCompany={setIncludeSampleCompany}
          // Features chosen on the switchboard already cover these tools.
          showTools={featureMode !== 'custom'}
          toggles={toggles}
          setToggle={(key, value) => {
            setToggles((current) => ({ ...current, [key]: value }))
            setFeatureChoices((current) => ({ ...current, [key]: value }))
          }}
        />
      )}
      {step === 'review' && (
        <ReviewStep
          t={t}
          name={name}
          legalName={legalName}
          country={country}
          currency={currency}
          fiscalMonth={fiscalMonth}
          timeZone={timeZone}
          defaults={{
            country: props.initial.country,
            currency: props.initial.baseCurrency,
            fiscalMonth: props.initial.fiscalYearStartMonth,
            // The stored zone, or the zone derived from the chosen country
            // when none was stored — the same default the state holds.
            timeZone: props.initial.timeZone && offeredTimeZones.has(props.initial.timeZone)
              ? props.initial.timeZone
              : countryDefaultTimeZone(country),
            teamSize: props.initial.workspaceProfile.teamSize,
            complexity: props.initial.workspaceProfile.complexity,
            bookStart: props.initial.workspaceProfile.bookStart,
            taxPosition: props.initial.workspaceProfile.taxPosition,
            monthlyActivity: props.initial.workspaceProfile.monthlyActivity,
            closeCadence: props.initial.workspaceProfile.closeCadence,
          }}
          teamSize={teamSize}
          complexity={complexity}
          bookStart={bookStart}
          taxPosition={taxPosition}
          monthlyActivity={monthlyActivity}
          closeCadence={closeCadence}
          industry={selectedIndustry}
          customFeatures={featureMode === 'custom'}
          featureKeys={reviewFeatureKeys}
          featureTitle={(key) => tAdmin(`features.${key}.title`)}
          includeSampleCompany={includeSampleCompany}
          payrollOn={payrollOn}
          payrollPack={payrollPack}
          payrollPacks={installablePacks}
          seedChartOfAccounts={Boolean(
            props.canSwitchIndustry
            && selectedIndustry
            && selectedIndustry.key !== props.initial.industry
          )}
        />
      )}
      {step === 'applying' && <ApplyingStep t={t} />}
      {step === 'profile' && complexity === 'essentials' && (
        <label className="mt-4 flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
          <input type="checkbox" checked={configureRhythm} onChange={(event) => setConfigureRhythm(event.target.checked)} />
          {t('rhythm.optional')}
        </label>
      )}
      {step === 'done' && <DoneStep t={t} sampleOrgId={sampleOrgId} bookStart={bookStart} actions={(props.launchActions ?? []).filter((action) => action !== 'statement' || featureChoices.banking)} onNavigate={(href) => {
        router.push(href)
        router.refresh()
      }} />}
    </WizardShell>
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
  timeZone: string
  countries: { value: string; label: string }[]
  currencies: { value: string; label: string }[]
  months: { value: number; label: string }[]
  timeZones: string[]
  setName: (v: string) => void
  setLegalName: (v: string) => void
  setCountry: (v: string) => void
  setCurrency: (v: string) => void
  setFiscalMonth: (v: number) => void
  setTimeZone: (v: string) => void
}) {
  const { t, name, legalName, country, currency, fiscalMonth, timeZone, countries, currencies, months, timeZones } = props
  // The comboboxes' selected values as plain text: an accessibility snapshot
  // that cannot expose a native select's current option still reads this
  // line, and aria-live announces it when a selection changes.
  const countryLabel = countries.find((option) => option.value === country)?.label ?? country
  const currencyLabel = currencies.find((option) => option.value === currency)?.label ?? currency
  const fiscalMonthLabel = months.find((option) => option.value === fiscalMonth)?.label ?? String(fiscalMonth)
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
          <label htmlFor="setup-company-name" className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">
            {t('company.name')}
          </label>
          <input
            id="setup-company-name"
            type="text"
            value={name}
            onChange={(e) => props.setName(e.target.value)}
            placeholder={t('company.namePlaceholder')}
            className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
            autoFocus
          />
        </div>
        <div>
          <label htmlFor="setup-legal-name" className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">
            {t('company.legalName')}
          </label>
          <input
            id="setup-legal-name"
            type="text"
            value={legalName}
            onChange={(e) => props.setLegalName(e.target.value)}
            placeholder={t('company.legalNamePlaceholder')}
            className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="setup-country" className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">
              {t('company.country')}
            </label>
            <select
              id="setup-country"
              value={country}
              onChange={(e) => props.setCountry(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm uppercase text-slate-900 placeholder:text-slate-400 focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
            >
              {countries.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="setup-currency" className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">
              {t('company.currency')}
            </label>
            <select
              id="setup-currency"
              value={currency}
              onChange={(e) => props.setCurrency(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm uppercase text-slate-900 placeholder:text-slate-400 focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
            >
              {currencies.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </div>
        </div>
        <div>
          <label htmlFor="setup-fiscal-month" className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">
            {t('company.fiscalYear')}
          </label>
          <select
            id="setup-fiscal-month"
            value={fiscalMonth}
            onChange={(e) => props.setFiscalMonth(Number(e.target.value))}
            className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-900 focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          >
            {months.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="setup-time-zone" className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">
            {t('company.timeZone')}
          </label>
          <select
            id="setup-time-zone"
            value={timeZone}
            onChange={(e) => props.setTimeZone(e.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-900 focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          >
            {timeZones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p aria-live="polite" className="rounded-lg bg-slate-50 p-3 text-xs leading-relaxed text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
        {t('company.selectedSummary', { country: countryLabel, currency: currencyLabel, fiscalMonth: fiscalMonthLabel, timeZone })}
      </p>
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
  /** "None of these fit" is chosen: the neutral chart, features picked individually. */
  customSelected: boolean
  onPickCustom: () => void
  canSwitch: boolean
  currentIndustry: string | null
}) {
  const { t, industries, selected, search, setSearch, onPick, customSelected, onPickCustom, canSwitch, currentIndustry } = props
  // Choosing features individually installs the neutral chart, so it is
  // locked exactly when switching to that preset would be.
  const customLocked = !canSwitch && currentIndustry !== null && currentIndustry !== NEUTRAL_INDUSTRY_KEY
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
          const isSelected = !customSelected && selected === ind.key
          // A company imported or created before an industry was classified
          // may already have postings. It may choose its initial classification
          // without replacing its established chart; only changing an existing
          // classification is locked after posting.
          const isLocked = !canSwitch && currentIndustry !== null && currentIndustry !== ind.key
          return (
            <motion.button
              key={ind.key}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: Math.min(i * 0.03, 0.3) }}
              whileHover={!isLocked ? { scale: 1.02 } : undefined}
              whileTap={!isLocked ? { scale: 0.98 } : undefined}
              type="button"
              aria-pressed={isSelected}
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

      {industries.length === 0 && search.trim() ? (
        <p className="rounded-lg bg-slate-50 p-3 text-center text-sm text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
          {t('industry.noMatches', { query: search.trim() })}
        </p>
      ) : null}

      <button
        type="button"
        aria-pressed={customSelected}
        disabled={customLocked}
        onClick={() => !customLocked && onPickCustom()}
        className={cn(
          'relative flex w-full items-start gap-3 rounded-xl border border-dashed p-4 text-left transition-colors',
          customSelected
            ? 'border-teal-500 bg-teal-50 ring-2 ring-teal-500/20 dark:border-teal-400 dark:bg-teal-950/40'
            : customLocked
              ? 'cursor-not-allowed border-slate-200 bg-slate-50 opacity-50 dark:border-slate-800 dark:bg-slate-800/50'
              : 'border-slate-300 hover:border-slate-400 hover:bg-slate-50 dark:border-slate-600 dark:hover:bg-slate-800/60',
        )}
      >
        <div
          className={cn(
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg transition-colors',
            customSelected ? 'bg-teal-500 text-white' : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
          )}
        >
          <SlidersHorizontal size={20} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('industry.custom.title')}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-slate-500 dark:text-slate-400">{t('industry.custom.description')}</p>
        </div>
        {customSelected && (
          <span className="absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded-full bg-teal-500">
            <Check className="text-white" size={12} strokeWidth={3} />
          </span>
        )}
      </button>

      {!canSwitch && currentIndustry && (
        <p className="text-center text-xs text-amber-600 dark:text-amber-400">
          {t('industry.locked')}
        </p>
      )}
      {!canSwitch && !currentIndustry && (
        <p className="text-center text-xs text-amber-600 dark:text-amber-400">
          {t('industry.classificationOnly')}
        </p>
      )}
    </div>
  )
}

function ProfileStep(props: {
  t: ReturnType<typeof useTranslations<'admin.setup.wizard'>>
  teamSize: TeamSize
  complexity: ComplexityLevel
  onTeamSize: (value: TeamSize) => void
  onComplexity: (value: ComplexityLevel) => void
}) {
  const teamOptions: { key: TeamSize; icon: typeof Users }[] = [
    { key: 'solo', icon: Users },
    { key: 'small', icon: Users },
    { key: 'medium', icon: Building2 },
    { key: 'large', icon: Building2 },
  ]
  const complexityOptions: { key: ComplexityLevel; icon: typeof ShieldCheck }[] = [
    { key: 'essentials', icon: Check },
    { key: 'growing', icon: Sparkles },
    { key: 'advanced', icon: ShieldCheck },
  ]
  return (
    <div className="space-y-7">
      <div>
        <h2 className="text-xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
          {props.t('profile.title')}
        </h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{props.t('profile.description')}</p>
      </div>
      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold text-slate-800 dark:text-slate-100">
          {props.t('profile.teamQuestion')}
        </legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {teamOptions.map(({ key, icon: Icon }, index) => {
            const selected = props.teamSize === key
            return (
              <motion.button
                key={key}
                type="button"
                aria-pressed={selected}
                onClick={() => props.onTeamSize(key)}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.04 }}
                whileHover={{ y: -2 }}
                whileTap={{ scale: 0.98 }}
                className={cn(
                  'flex items-center gap-3 rounded-xl border p-4 text-left transition-colors',
                  selected
                    ? 'border-teal-500 bg-gradient-to-br from-teal-50 to-cyan-50 ring-2 ring-teal-500/20 dark:from-teal-950/50 dark:to-cyan-950/30'
                    : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800/60',
                )}
              >
                <span className={cn('rounded-lg p-2', selected ? 'bg-teal-600 text-white' : 'bg-slate-100 text-slate-500 dark:bg-slate-800')}>
                  <Icon size={18} />
                </span>
                <span>
                  <span className="block text-sm font-semibold text-slate-900 dark:text-slate-100">{props.t(`profile.team.${key}.title`)}</span>
                  <span className="block text-xs text-slate-500 dark:text-slate-400">{props.t(`profile.team.${key}.description`)}</span>
                </span>
              </motion.button>
            )
          })}
        </div>
      </fieldset>
      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold text-slate-800 dark:text-slate-100">
          {props.t('profile.complexityQuestion')}
        </legend>
        <div className="grid gap-3 sm:grid-cols-3">
          {complexityOptions.map(({ key, icon: Icon }, index) => {
            const selected = props.complexity === key
            return (
              <motion.button
                key={key}
                type="button"
                aria-pressed={selected}
                onClick={() => props.onComplexity(key)}
                initial={{ opacity: 0, scale: 0.97 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: 0.12 + index * 0.05 }}
                whileHover={{ y: -3 }}
                whileTap={{ scale: 0.98 }}
                className={cn(
                  'relative h-full min-h-36 overflow-hidden rounded-xl border p-4 text-left transition-colors',
                  selected
                    ? 'border-teal-500 bg-slate-950 text-white ring-2 ring-teal-500/30 dark:bg-teal-950'
                    : 'border-slate-200 bg-white hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900',
                )}
              >
                {selected ? <motion.span layoutId="profile-glow" className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-teal-400 via-cyan-400 to-violet-400" /> : null}
                <Icon size={20} className={selected ? 'text-teal-300' : 'text-slate-400'} />
                <span className="mt-3 block text-sm font-semibold">{props.t(`profile.complexity.${key}.title`)}</span>
                <span className={cn('mt-1 block text-xs leading-relaxed', selected ? 'text-slate-300' : 'text-slate-500 dark:text-slate-400')}>
                  {props.t(`profile.complexity.${key}.description`)}
                </span>
              </motion.button>
            )
          })}
        </div>
      </fieldset>
      <motion.div
        animate={{ borderColor: 'rgb(153 246 228)' }}
        transition={{ duration: 0.2 }}
        className="flex min-h-20 items-start gap-3 rounded-xl border border-teal-200 bg-teal-50/70 p-4 text-sm text-teal-900 dark:border-teal-900 dark:bg-teal-950/30 dark:text-teal-200"
      >
        <Sparkles className="mt-0.5 shrink-0" size={18} />
        <p>{props.t('profile.adapting')}</p>
      </motion.div>
    </div>
  )
}

function OperationsStep(props: {
  t: ReturnType<typeof useTranslations<'admin.setup.wizard'>>
  toggles: Record<ToggleKey, boolean>
  setToggles: React.Dispatch<React.SetStateAction<Record<ToggleKey, boolean>>>
}) {
  const { t, toggles, setToggles } = props
  const workItems: { key: ToggleKey; icon: typeof Building2 }[] = [
    { key: 'projects', icon: Briefcase },
    { key: 'timeTracking', icon: Check },
    { key: 'inventory', icon: Warehouse },
    { key: 'subscriptionBilling', icon: Repeat },
    { key: 'orders', icon: Download },
    { key: 'crm', icon: HeartHandshake },
    { key: 'payroll', icon: Wallet },
  ]
  const structureItems: { key: ToggleKey; icon: typeof Building2 }[] = [
    { key: 'multiSubsidiary', icon: Building2 },
    { key: 'multiCurrency', icon: Coins },
  ]

  // Time tracking stands alone: hourly time needs no job costing, so the
  // Projects and Time tracking toggles are independent. Project capabilities
  // that need Projects keep their own parent/child enforcement server-side.
  const toggle = (key: ToggleKey) => setToggles((previous) => {
    const next = { ...previous, [key]: !previous[key] }
    return next
  })

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
          {t('operations.title')}
        </h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{t('operations.description')}</p>
      </div>
      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t('operations.workTitle')}</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {workItems.map(({ key, icon: Icon }) => (
            <ToggleRow key={key} icon={<Icon size={18} />} label={t(`operations.${key}.title`)}
              description={t(`operations.${key}.description`)} on={toggles[key]} onToggle={() => toggle(key)} />
          ))}
        </div>
      </fieldset>
      <fieldset className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/70 p-4 dark:border-slate-700 dark:bg-slate-950/40">
        <legend className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t('operations.structureTitle')}</legend>
        <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">{t('operations.structureDescription')}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {structureItems.map(({ key, icon: Icon }) => (
            <ToggleRow key={key} icon={<Icon size={18} />} label={t(`operations.${key}.title`)}
              description={t(`operations.${key}.description`)} on={toggles[key]} onToggle={() => toggle(key)} />
          ))}
        </div>
      </fieldset>
      <p className="rounded-lg bg-slate-50 p-3 text-xs text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
        {t('operations.note')}
      </p>
      <p className="rounded-lg bg-slate-50 p-3 text-xs text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
        {t('operations.agentsNote')}
      </p>
    </div>
  )
}

function RhythmStep(props: {
  t: ReturnType<typeof useTranslations<'admin.setup.wizard'>>
  monthlyActivity: MonthlyActivityLevel
  closeCadence: CloseCadence
  onMonthlyActivity: (value: MonthlyActivityLevel) => void
  onCloseCadence: (value: CloseCadence) => void
}) {
  const activityOptions: MonthlyActivityLevel[] = ['light', 'steady', 'high']
  const cadenceOptions: CloseCadence[] = ['monthly', 'quarterly', 'annual']
  return (
    <div className="space-y-7">
      <div>
        <h2 className="text-xl font-bold tracking-tight text-slate-900 dark:text-slate-100">{props.t('rhythm.title')}</h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{props.t('rhythm.description')}</p>
      </div>
      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold text-slate-800 dark:text-slate-100">{props.t('rhythm.activityQuestion')}</legend>
        <p className="text-xs text-slate-500 dark:text-slate-400">{props.t('rhythm.activityHint')}</p>
        <div className="grid gap-3 sm:grid-cols-3">
          {activityOptions.map((value, index) => {
            const selected = props.monthlyActivity === value
            return (
              <motion.button key={value} type="button" aria-pressed={selected} onClick={() => props.onMonthlyActivity(value)}
                initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.05 }}
                whileHover={{ y: -2 }} whileTap={{ scale: 0.98 }}
                className={cn('min-h-32 rounded-xl border p-4 text-left transition-colors', selected
                  ? 'border-teal-500 bg-gradient-to-br from-teal-50 to-cyan-50 ring-2 ring-teal-500/20 dark:from-teal-950/50 dark:to-cyan-950/30'
                  : 'border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800/60')}>
                <BarChart3 size={20} className={selected ? 'text-teal-600 dark:text-teal-300' : 'text-slate-400'} />
                <span className="mt-3 block text-sm font-semibold text-slate-900 dark:text-slate-100">{props.t(`rhythm.activity.${value}.title`)}</span>
                <span className="mt-1 block text-xs leading-relaxed text-slate-500 dark:text-slate-400">{props.t(`rhythm.activity.${value}.description`)}</span>
              </motion.button>
            )
          })}
        </div>
      </fieldset>
      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold text-slate-800 dark:text-slate-100">{props.t('rhythm.closeQuestion')}</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          {cadenceOptions.map((value, index) => {
            const selected = props.closeCadence === value
            return (
              <motion.button key={value} type="button" aria-pressed={selected} onClick={() => props.onCloseCadence(value)}
                initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.16 + index * 0.05 }}
                whileHover={{ y: -2 }} whileTap={{ scale: 0.98 }}
                className={cn('flex min-h-24 items-start gap-3 rounded-xl border p-4 text-left transition-colors', selected
                  ? 'border-teal-500 bg-slate-950 text-white ring-2 ring-teal-500/20 dark:bg-teal-950'
                  : 'border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800/60')}>
                <CalendarRange size={19} className={selected ? 'text-teal-300' : 'text-slate-400'} />
                <span><span className="block text-sm font-semibold">{props.t(`rhythm.close.${value}.title`)}</span>
                  <span className={cn('mt-1 block text-xs leading-relaxed', selected ? 'text-slate-300' : 'text-slate-500 dark:text-slate-400')}>{props.t(`rhythm.close.${value}.description`)}</span></span>
              </motion.button>
            )
          })}
        </div>
      </fieldset>
      <p className="rounded-lg bg-slate-50 p-3 text-xs leading-relaxed text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">{props.t('rhythm.note')}</p>
    </div>
  )
}

function PayrollStep(props: {
  t: WizardT
  /** Installable packs, in registry order — the cards render whatever is declared. */
  packs: WizardPayrollPack[]
  pack: PayrollPack
  setPack: (value: PayrollPack) => void
}) {
  const { t, packs, pack, setPack } = props
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold tracking-tight text-slate-900 dark:text-slate-100">{t('payroll.title')}</h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{t('payroll.description')}</p>
      </div>
      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t('payroll.packQuestion')}</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {packs.map((packEntry) => {
            const { country: code, name } = packEntry
            const selected = pack === code
            return (
              <button
                key={code}
                type="button"
                aria-pressed={selected}
                onClick={() => setPack(selected ? null : code)}
                className={cn(
                  'relative flex items-start gap-3 rounded-xl border p-4 text-left transition-colors',
                  selected
                    ? 'border-teal-500 bg-teal-50 ring-2 ring-teal-500/20 dark:border-teal-400 dark:bg-teal-950/40'
                    : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800/60',
                )}
              >
                <span className={cn('rounded-lg p-2', selected ? 'bg-teal-600 text-white' : 'bg-slate-100 text-slate-400 dark:bg-slate-800')}>
                  <Landmark size={18} />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-slate-900 dark:text-slate-100">{packTitle(t, code, name)}</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-slate-500 dark:text-slate-400">{packDescription(t, code, packEntry)}</span>
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
      </fieldset>
      <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50/70 p-4 dark:border-slate-700 dark:bg-slate-950/40">
        <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t('payroll.checklist.title')}</p>
        <ul className="space-y-1.5 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          <li>
            {t('payroll.checklist.pack')}
          </li>
          <li>
            {t('payroll.checklist.accounts')}{' '}
            <Link href={'/admin/setup/payroll?tab=accounts' as never} className="font-medium text-teal-700 hover:underline dark:text-teal-300">
              {t('payroll.checklist.accountsLink')}
            </Link>
          </li>
          <li>
            {t('payroll.checklist.schedule')}{' '}
            <Link href={'/admin/setup/payroll?tab=schedules' as never} className="font-medium text-teal-700 hover:underline dark:text-teal-300">
              {t('payroll.checklist.scheduleLink')}
            </Link>
          </li>
        </ul>
      </div>
    </div>
  )
}

function LaunchStep(props: {
  t: ReturnType<typeof useTranslations<'admin.setup.wizard'>>
  bookStart: BookStart
  taxPosition: TaxPosition
  includeSampleCompany: boolean
  setBookStart: (value: BookStart) => void
  setTaxPosition: (value: TaxPosition) => void
  setIncludeSampleCompany: (value: boolean) => void
  /** The bank-feed / online-payment / fixed-asset shortcuts; hidden when the
   *  operator already chose every feature on the switchboard. */
  showTools: boolean
  toggles: Record<ToggleKey, boolean>
  setToggle: (key: 'bankFeeds' | 'onlinePayments' | 'fixedAssets', value: boolean) => void
}) {
  const launchFeatures: { key: 'bankFeeds' | 'onlinePayments' | 'fixedAssets'; icon: typeof Building2 }[] = [
    { key: 'bankFeeds', icon: Landmark },
    { key: 'onlinePayments', icon: CreditCard },
    { key: 'fixedAssets', icon: Boxes },
  ]
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold tracking-tight text-slate-900 dark:text-slate-100">{props.t('launch.title')}</h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{props.t('launch.description')}</p>
      </div>
      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold text-slate-800 dark:text-slate-100">{props.t('launch.booksQuestion')}</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {(['fresh', 'migrate'] as const).map((value) => {
            const selected = props.bookStart === value
            const Icon = value === 'fresh' ? Sparkles : Download
            return (
              <button key={value} type="button" aria-pressed={selected} onClick={() => props.setBookStart(value)}
                className={cn('flex items-start gap-3 rounded-xl border p-4 text-left transition-colors', selected
                  ? 'border-teal-500 bg-teal-50 ring-2 ring-teal-500/20 dark:bg-teal-950/40'
                  : 'border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800/60')}>
                <span className={cn('rounded-lg p-2', selected ? 'bg-teal-600 text-white' : 'bg-slate-100 text-slate-400 dark:bg-slate-800')}><Icon size={18} /></span>
                <span><span className="block text-sm font-semibold text-slate-900 dark:text-slate-100">{props.t(`launch.books.${value}.title`)}</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-slate-500 dark:text-slate-400">{props.t(`launch.books.${value}.description`)}</span></span>
              </button>
            )
          })}
        </div>
      </fieldset>
      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold text-slate-800 dark:text-slate-100">{props.t('launch.taxQuestion')}</legend>
        <div className="grid grid-cols-3 gap-2">
          {(['registered', 'not_registered', 'unsure'] as const).map((value) => {
            const selected = props.taxPosition === value
            return <button key={value} type="button" aria-pressed={selected} onClick={() => props.setTaxPosition(value)}
              className={cn('rounded-lg border px-3 py-2.5 text-xs font-medium transition-colors', selected
                ? 'border-teal-500 bg-slate-950 text-white dark:bg-teal-950'
                : 'border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800')}>
              {props.t(`launch.tax.${value}`)}
            </button>
          })}
        </div>
      </fieldset>
      {props.showTools ? <fieldset className="space-y-3">
        <legend className="text-sm font-semibold text-slate-800 dark:text-slate-100">{props.t('launch.toolsQuestion')}</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          {launchFeatures.map(({ key, icon: Icon }) => (
            <ToggleRow key={key} icon={<Icon size={18} />} label={props.t(`launch.features.${key}.title`)}
              description={props.t(`launch.features.${key}.description`)} on={props.toggles[key]}
              onToggle={() => props.setToggle(key, !props.toggles[key])} />
          ))}
        </div>
      </fieldset> : null}
      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold text-slate-800 dark:text-slate-100">{props.t('launch.sample.question')}</legend>
        <ToggleRow
          icon={<Sparkles size={18} />}
          label={props.t('launch.sample.title')}
          description={props.t('launch.sample.description')}
          on={props.includeSampleCompany}
          onToggle={() => props.setIncludeSampleCompany(!props.includeSampleCompany)}
        />
        <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">{props.t('launch.sample.safety')}</p>
      </fieldset>
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
      aria-pressed={props.on}
      onClick={props.onToggle}
      className={cn(
        'flex h-full min-h-20 w-full items-center gap-3 rounded-xl border bg-white p-3.5 text-left transition-colors dark:bg-slate-900',
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
  legalName: string
  country: string
  currency: string
  fiscalMonth: number
  timeZone: string
  /** The pre-selected values the wizard opened with: a review value still
   *  equal to its default was accepted by click-through, never deliberately
   *  chosen, and is badged so. */
  defaults: {
    country: string
    currency: string
    fiscalMonth: number
    timeZone: string
    teamSize: TeamSize
    complexity: ComplexityLevel
    bookStart: BookStart
    taxPosition: TaxPosition
    monthlyActivity: MonthlyActivityLevel
    closeCadence: CloseCadence
  }
  teamSize: TeamSize
  complexity: ComplexityLevel
  bookStart: BookStart
  taxPosition: TaxPosition
  monthlyActivity: MonthlyActivityLevel
  closeCadence: CloseCadence
  industry?: IndustryDef
  /** No preset fits: the neutral chart with features chosen individually. */
  customFeatures: boolean
  featureKeys: string[]
  featureTitle: (key: string) => string
  includeSampleCompany: boolean
  payrollOn: boolean
  payrollPack: PayrollPack
  payrollPacks: WizardPayrollPack[]
  seedChartOfAccounts: boolean
}) {
  const locale = useLocale()
  const { t, name, legalName, country, currency, fiscalMonth, timeZone, defaults, teamSize, complexity, bookStart, taxPosition, monthlyActivity, closeCadence, industry, customFeatures, featureKeys, featureTitle, includeSampleCompany, payrollOn, payrollPack, payrollPacks, seedChartOfAccounts } = props
  const payrollPackName = payrollPack
    ? (payrollPacks.find((pack) => pack.country === payrollPack)?.name ?? payrollPack)
    : null
  const fiscalMonthName = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2026, fiscalMonth - 1, 1)),
  )
  const defaultBadge = t('review.defaultBadge')
  const anyDefault = country === defaults.country || currency === defaults.currency
    || fiscalMonth === defaults.fiscalMonth || timeZone === defaults.timeZone || teamSize === defaults.teamSize
    || complexity === defaults.complexity || bookStart === defaults.bookStart
    || taxPosition === defaults.taxPosition || monthlyActivity === defaults.monthlyActivity
    || closeCadence === defaults.closeCadence
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
          {t('review.title')}
        </h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{t('review.description')}</p>
      </div>
      {anyDefault && (
        <p className="rounded-lg bg-slate-50 p-3 text-xs leading-relaxed text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
          {t('review.defaultsHint')}
        </p>
      )}
      <div className="space-y-2 rounded-xl border border-slate-200 p-4 dark:border-slate-700">
        <ReviewRow label={t('review.companyName')} value={name} />
        <ReviewRow label={t('review.legalName')} value={legalName || t('review.notProvided')} />
        <ReviewRow label={t('review.country')} value={country.toUpperCase()} isDefault={country === defaults.country} defaultBadge={defaultBadge} />
        <ReviewRow label={t('review.currency')} value={currency} isDefault={currency === defaults.currency} defaultBadge={defaultBadge} />
        <ReviewRow label={t('review.fiscalYear')} value={fiscalMonthName} isDefault={fiscalMonth === defaults.fiscalMonth} defaultBadge={defaultBadge} />
        <ReviewRow label={t('review.timeZone')} value={timeZone} isDefault={timeZone === defaults.timeZone} defaultBadge={defaultBadge} />
        <ReviewRow label={t('review.teamSize')} value={t(`profile.team.${teamSize}.title`)} isDefault={teamSize === defaults.teamSize} defaultBadge={defaultBadge} />
        <ReviewRow label={t('review.complexity')} value={t(`profile.complexity.${complexity}.title`)} isDefault={complexity === defaults.complexity} defaultBadge={defaultBadge} />
        <ReviewRow label={t('review.bookStart')} value={t(`launch.books.${bookStart}.title`)} isDefault={bookStart === defaults.bookStart} defaultBadge={defaultBadge} />
        <ReviewRow label={t('review.taxPosition')} value={t(`launch.tax.${taxPosition}`)} isDefault={taxPosition === defaults.taxPosition} defaultBadge={defaultBadge} />
        <ReviewRow label={t('review.monthlyActivity')} value={t(`rhythm.activity.${monthlyActivity}.title`)} isDefault={monthlyActivity === defaults.monthlyActivity} defaultBadge={defaultBadge} />
        <ReviewRow label={t('review.closeCadence')} value={t(`rhythm.close.${closeCadence}.title`)} isDefault={closeCadence === defaults.closeCadence} defaultBadge={defaultBadge} />
        <ReviewRow
          label={t('review.sampleCompany')}
          value={includeSampleCompany ? t('review.sampleCompanyYes') : t('review.sampleCompanyNo')}
        />
        {payrollOn && (
          <ReviewRow
            label={t('review.payrollPack')}
            value={payrollPack && payrollPackName ? packTitle(t, payrollPack, payrollPackName) : t('review.payrollPackNone')}
          />
        )}
        {industry && (
          <>
            <ReviewRow
              label={t('review.industry')}
              value={customFeatures ? t('review.industryCustom') : t(`industries.${industry.key}.title`)}
            />
            <ReviewRow
              label={t('review.chartOfAccounts')}
              value={seedChartOfAccounts
                ? customFeatures
                  ? t('review.chartNeutral', { count: industry.coa.length })
                  : `${industry.coa.length} ${t('review.accounts')}`
                : t('review.chartPreserved')}
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
      <p className="text-xs text-slate-400 dark:text-slate-500">
        {t(seedChartOfAccounts ? 'review.note' : 'review.notePreserved')}
      </p>
    </div>
  )
}

function ReviewRow({ label, value, isDefault, defaultBadge }: { label: string; value: string; isDefault?: boolean; defaultBadge?: string }) {
  return (
    <div className="flex items-center justify-between gap-2 py-1">
      <span className="text-sm text-slate-500 dark:text-slate-400">{label}</span>
      <span className="flex items-center gap-2 text-sm font-medium text-slate-900 dark:text-slate-100">
        {isDefault && defaultBadge ? (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
            {defaultBadge}
          </span>
        ) : null}
        {value}
      </span>
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

function DoneStep({ t, sampleOrgId, bookStart, actions, onNavigate }: {
  t: ReturnType<typeof useTranslations<'admin.setup.wizard'>>
  bookStart: BookStart
  sampleOrgId: string | null
  actions: SetupLaunchAction[]
  onNavigate: (href: string) => void
}) {
  const tMigration = useTranslations('sync.migrationAssistant')
  const destinations: Record<SetupLaunchAction, string> = {
    invoice: documentCreateHref('/ar/invoices', 'customer_invoice'),
    assistant: MIGRATION_WORKSPACE_HREF,
    migrate: '/sync', statement: '/banking/imports', demo: '/admin/setup/company#sample-companies',
  }
  // Bringing existing books starts in the guided cutover, which works with or
  // without the assistant; starting fresh offers it after the first invoice.
  const preferred: SetupLaunchAction = bookStart === 'migrate'
    ? actions.includes('assistant') ? 'assistant' : 'migrate'
    : 'invoice'
  const ordered = [preferred, ...actions.filter((action) => action !== preferred)]
    .filter((action) => actions.includes(action) && !(sampleOrgId && action === 'demo'))
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
      <div className="mt-6 flex w-full max-w-md flex-col gap-3">
        {sampleOrgId && <form action={enterOrg.bind(null, sampleOrgId, '/')}>
          <button type="submit" className="w-full rounded-lg border border-teal-600 bg-teal-600 px-4 py-3 text-sm font-medium text-white hover:bg-teal-700">
            {t('done.actions.demo')}
          </button>
        </form>}
        {ordered.map((action, index) => (
          <button key={action} type="button" onClick={() => onNavigate(destinations[action])}
            className={cn('rounded-lg border px-4 py-3 text-sm font-medium', index === 0
              ? 'border-teal-600 bg-teal-600 text-white hover:bg-teal-700'
              : 'border-slate-200 text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800')}>
            {action === 'assistant' ? tMigration('entry.cutover') : t(`done.actions.${action}`)}
          </button>
        ))}
        <button type="button" onClick={() => onNavigate('/admin/setup/readiness')} className="py-2 text-sm text-teal-700 underline dark:text-teal-300">
          {t('done.actions.readiness')}
        </button>
      </div>
    </div>
  )
}

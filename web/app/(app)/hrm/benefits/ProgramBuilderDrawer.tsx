'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { AlertTriangle } from 'lucide-react'
import { Alert, Badge, Button, Drawer, Input, Label, SearchSelect, Select, Textarea } from '@openbooks/ui'
import { FormSteps } from '../../../../components/builder/builder-kit'
import { readApiErrorMessage } from '../../../../lib/api-error'
import { useMoney } from '../../../../components/money-provider'
import { useDirtyClose } from '../../../../lib/use-dirty-close'
import { canonicalDecimal } from '@openbooks/engine/money/decimal'
import {
  componentsForDelivery,
  type BenefitPayComponentOption,
  BENEFIT_PROGRAMS_API,
  emptyProgramDraft,
  programResourceUrl,
  validateProgramDraft,
  translatedFieldErrors,
  decimalFieldRefusal,
  type BuilderOption as PortfolioOption,
  type FieldErrors,
  type ProgramDraft,
  type ProgramEditSeed,
  type ProgramFamily,
} from '../../../../lib/hrm/benefits-portfolio'

/**
 * Program builder, opened from the page header through `program=new`
 * (cards preselect `family=`) or from a program drawer through
 * `program=<id>&edit=1` for draft edits. Guided steps — offer,
 * eligibility, value, timing, controls, delivery — with a live policy
 * summary beside the form and field-level refusals before anything crosses
 * the wire.
 *
 * Scoped selections are loader-resolved option lists with a search filter —
 * departments, projects, and source accounts are picked, never hand-typed
 * UUID text. Quarterly and annual frequencies name their period basis
 * (calendar or fiscal) because settlement and payroll must agree on the
 * period. Amount readability uses the shared money classifier, never a
 * local one; the domain service re-validates every field on write.
 * Creation lands as a draft the detail drawer reads back from the server,
 * so the operator sees authoritative state — never an echo of typing.
 */

const STEPS = ['offer', 'eligibility', 'value', 'timing', 'controls', 'delivery', 'review'] as const
type Step = (typeof STEPS)[number]


function seedDraft(family: ProgramFamily, seed: ProgramEditSeed | null): ProgramDraft {
  if (!seed) return emptyProgramDraft(family)
  const text = (value: string | null): string => value ?? ''
  return {
    code: seed.code,
    name: seed.name,
    family: seed.family,
    description: text(seed.description),
    legalEntityId: text(seed.legalEntityId),
    currency: seed.currency,
    effectiveFrom: seed.effectiveFrom,
    effectiveTo: text(seed.effectiveTo),
    payComponentId: text(seed.payComponentId),
    deliveryMethod: seed.deliveryMethod,
    approvalMode: seed.approvalMode,
    valuation: seed.valuation,
    metric: seed.metric,
    metricScope: seed.metricScope,
    scopeIds: [...seed.scopeIds],
    allocation: seed.allocation,
    percentRate: text(seed.percentRate),
    fixedAmount: text(seed.fixedAmount),
    capAmount: text(seed.capAmount),
    budgetAmount: text(seed.budgetAmount),
    thresholdAmount: text(seed.thresholdAmount),
    frequency: seed.frequency,
    periodBasis: seed.periodBasis ?? '',
    paymentDelayDays: String(seed.paymentDelayDays),
    sourceAccountIds: [...seed.sourceAccountIds],
  }
}

function stepFields(step: Step): (keyof ProgramDraft)[] {
  switch (step) {
    case 'offer':
      return ['code', 'name', 'family', 'description']
    case 'eligibility':
      return ['legalEntityId']
    case 'value':
      return ['currency', 'fixedAmount', 'percentRate', 'budgetAmount', 'metric', 'scopeIds', 'capAmount', 'thresholdAmount']
    case 'timing':
      return ['effectiveFrom', 'effectiveTo', 'frequency', 'periodBasis', 'paymentDelayDays']
    case 'controls':
      return ['approvalMode', 'allocation', 'sourceAccountIds']
    case 'delivery':
      return ['deliveryMethod', 'payComponentId']
    case 'review':
      return []
  }
}

/** Searchable multi-pick over loader-resolved options. Selections are ids
 *  the service already authorized; the filter narrows locally, never
 *  re-queries, so unshown options stay selected. */
function OptionMultiPicker({
  id,
  label,
  options,
  selected,
  onChange,
  searchPlaceholder,
  emptyLabel,
  errorId,
  error,
}: {
  id: string
  label: string
  options: PortfolioOption[]
  selected: string[]
  onChange: (selected: string[]) => void
  searchPlaceholder: string
  emptyLabel: string
  errorId?: string
  error?: string
}) {
  const [filter, setFilter] = useState('')
  const visible = options.filter((o) => o.label.toLowerCase().includes(filter.trim().toLowerCase()))
  const chosen = new Set(selected)
  function toggle(value: string) {
    onChange(chosen.has(value) ? selected.filter((v) => v !== value) : [...selected, value])
  }
  return (
    <div>
      <span id={`${id}-label`} className="mb-1 block text-sm font-medium">
        {label}
      </span>
      <Input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder={searchPlaceholder}
        aria-label={searchPlaceholder}
      />
      <div role="group" aria-labelledby={`${id}-label`} className="mt-2 max-h-44 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2 dark:border-slate-700">
        {visible.length === 0 ? (
          <p className="px-1 py-1 text-xs text-slate-500 dark:text-slate-400">{emptyLabel}</p>
        ) : (
          visible.map((o) => (
            <label key={o.value} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-slate-50 dark:hover:bg-slate-800/60">
              <input
                type="checkbox"
                className="h-4 w-4 rounded"
                checked={chosen.has(o.value)}
                onChange={() => toggle(o.value)}
                aria-label={o.label}
              />
              <span className="min-w-0 truncate text-slate-700 dark:text-slate-200">{o.label}</span>
            </label>
          ))
        )}
      </div>
      {selected.length > 0 ? (
        <p className="mt-1 text-xs tabular-nums text-slate-500 dark:text-slate-400">
          {selected.length} · {options.filter((o) => chosen.has(o.value)).map((o) => o.label).slice(0, 3).join(' · ')}
          {selected.length > 3 ? ' …' : ''}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="mt-1 text-xs text-red-700 dark:text-red-300">
          {error}
        </p>
      ) : null}
    </div>
  )
}

function buildPayload(draft: ProgramDraft, mode: 'create' | 'edit', reason: string): Record<string, unknown> {
  const optional = (value: string): string | null => (value.trim() === '' ? null : value.trim())
  const shared = {
    name: draft.name.trim(),
    description: optional(draft.description),
    legalEntityId: draft.legalEntityId === '' ? null : draft.legalEntityId,
    currency: draft.currency.trim().toUpperCase(),
    effectiveFrom: draft.effectiveFrom,
    effectiveTo: optional(draft.effectiveTo),
    payComponentId: draft.payComponentId === '' ? null : draft.payComponentId,
    deliveryMethod: draft.deliveryMethod,
    approvalMode: draft.approvalMode,
    valuation: draft.valuation,
    metric: draft.family === 'incentive' && draft.metric !== '' ? draft.metric : null,
    metricScope: draft.family === 'incentive' ? draft.metricScope : null,
    scopeIds: draft.family === 'incentive' ? draft.scopeIds : [],
    allocation: draft.allocation,
    percentRate: optional(draft.percentRate),
    fixedAmount: optional(draft.fixedAmount),
    capAmount: optional(draft.capAmount),
    budgetAmount: optional(draft.budgetAmount),
    thresholdAmount: optional(draft.thresholdAmount),
    frequency: draft.frequency,
    periodBasis: draft.periodBasis === '' ? null : draft.periodBasis,
    paymentDelayDays: draft.paymentDelayDays.trim() === '' ? 0 : Number(draft.paymentDelayDays.trim()),
    sourceAccountIds: draft.sourceAccountIds,
  }
  if (mode === 'create') {
    return {
      action: 'create',
      code: draft.code.trim(),
      family: draft.family,
      ...shared,
    }
  }
  // Updates replace the measured set (drafts only): the seed carries the
  // authoritative accounts, and a failed source read blocks the edit rather
  // than implying a cleared set.
  return { action: 'update', ...shared, reason }
}

function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null
  return (
    <p id={id} role="alert" className="mt-1 text-xs text-red-700 dark:text-red-300">
      {message}
    </p>
  )
}

export function ProgramBuilderDrawer({
  closeHref,
  initialFamily,
  subsidiaryOptions,
  currencyOptions,
  departmentOptions,
  projectOptions,
  payComponentOptions,
  accountOptions,
  employmentsTruncated,
  mode = 'create',
  programId = null,
  editSeed = null,
  canConfigureApprovalPolicies = false,
}: {
  closeHref: string
  initialFamily: ProgramFamily
  familyLocked: boolean
  currencyOptions: (PortfolioOption & { scopeValue: string | null })[]
  subsidiaryOptions: PortfolioOption[]
  departmentOptions: PortfolioOption[]
  projectOptions: PortfolioOption[]
  payComponentOptions: BenefitPayComponentOption[]
  accountOptions: PortfolioOption[]
  employmentsTruncated: boolean
  canConfigureApprovalPolicies?: boolean
  mode?: 'create' | 'edit'
  programId?: string | null
  editSeed?: ProgramEditSeed | null
}) {
  const t = useTranslations('hrm')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const { money } = useMoney()
  const [draft, setDraft] = useState<ProgramDraft>(() => seedDraft(initialFamily, editSeed))
  const enabledCurrencies = currencyOptions.filter((option) => option.scopeValue === null || option.scopeValue === draft.legalEntityId)
  const deliveryComponents = componentsForDelivery(payComponentOptions, draft.deliveryMethod)
  const [step, setStep] = useState<Step>('offer')
  const [errors, setErrors] = useState<FieldErrors>({})
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)

  function close() {
    router.push(closeHref as never)
    router.refresh()
  }

  const dirty = useMemo(
    () =>
      draft.code.trim() !== '' ||
      draft.name.trim() !== '' ||
      draft.family !== initialFamily ||
      draft.description.trim() !== '' ||
      draft.currency.trim() !== '' ||
      draft.effectiveFrom !== '' ||
      reason.trim() !== '',
    [draft, initialFamily, reason],
  )
  const closeGuard = useDirtyClose({
    dirty,
    busy: saving,
    onClose: close,
    message: tCommon('feedback.unsavedChanges'),
    confirmLabel: tCommon('confirm.discardChanges'),
  })

  function set<K extends keyof ProgramDraft>(key: K, value: ProgramDraft[K]) {
    setDraft((current) => {
      const next = { ...current, [key]: value }
      if (key === 'legalEntityId' && !currencyOptions.some((option) => option.value === current.currency && (option.scopeValue === null || option.scopeValue === value))) next.currency = ''
      return next
    })
    setErrors((current) => {
      if (!current[key]) return current
      const next = { ...current }
      delete next[key]
      return next
    })
  }

  /** Step-local refusals: only the current step's fields block Next. */
  function next() {
    const all = translatedFieldErrors(validateProgramDraft(draft), t)
    if (draft.currency && !enabledCurrencies.some((option) => option.value === draft.currency)) all.currency = t('portfolio.builder.currencyUnavailable')
    const blocking = stepFields(step).filter((field) => all[field] !== undefined)
    if (blocking.length > 0) {
      const scoped: FieldErrors = {}
      for (const field of blocking) scoped[field] = all[field]
      setErrors(scoped)
      toast.error(t('portfolio.builder.fixFields'))
      return
    }
    // Unreadable money stops here with the shared classifier's remedy —
    // the server would refuse it by the same name. canonicalDecimal is the
    // single gate; moneyRefusal only composes the message.
    for (const field of ['fixedAmount', 'percentRate', 'capAmount', 'budgetAmount', 'thresholdAmount'] as const) {
      const raw = draft[field].trim()
      if (stepFields(step).includes(field) && raw !== '' && canonicalDecimal(raw, 4) === null) {
        const message = decimalFieldRefusal(raw, t(`portfolio.builder.fields.${field}`), t)
        setErrors({ [field]: message })
        return
      }
    }
    setStep(STEPS[STEPS.indexOf(step) + 1] ?? 'review')
  }

  async function save() {
    for (const field of ['fixedAmount', 'percentRate', 'capAmount', 'budgetAmount', 'thresholdAmount'] as const) {
      const raw = draft[field].trim()
      if (raw !== '' && canonicalDecimal(raw, 4) === null) {
        setErrors({ [field]: decimalFieldRefusal(raw, t(`portfolio.builder.fields.${field}`), t) })
        setStep('value')
        return
      }
    }
    const all = translatedFieldErrors(validateProgramDraft(draft), t)
    if (draft.currency && !enabledCurrencies.some((option) => option.value === draft.currency)) all.currency = t('portfolio.builder.currencyUnavailable')
    if (Object.keys(all).length > 0) {
      setErrors(all)
      setStep(STEPS.find((name) => stepFields(name).some((field) => all[field] !== undefined)) ?? 'offer')
      toast.error(t('portfolio.builder.fixFields'))
      return
    }
    if (mode === 'edit' && reason.trim() === '') {
      toast.error(t('portfolio.builder.reasonRequired'))
      setStep('review')
      return
    }
    setSaving(true)
    try {
      const url = mode === 'edit' && programId ? programResourceUrl(programId) : BENEFIT_PROGRAMS_API
      const res = await fetch(url, {
        method: mode === 'edit' ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildPayload(draft, mode, reason.trim())),
      })
      // res.ok first, always: a refusal body is read only for its message.
      if (!res.ok) {
        toast.error(await readApiErrorMessage(res, t('portfolio.builder.createFailed')))
        return
      }
      const body: unknown = await res.json().catch(() => null)
      const id =
        body !== null && typeof body === 'object' && 'program' in body &&
        body.program !== null && typeof body.program === 'object' && 'id' in body.program
          ? String((body.program as { id: unknown }).id)
          : null
      const params = new URLSearchParams(closeHref.split('?')[1] ?? '')
      params.delete('program')
      params.delete('edit')
      if (id) params.set('program', id)
      const query = params.toString()
      router.push(`${closeHref.split('?')[0]}${query ? `?${query}` : ''}` as never)
      router.refresh()
    } catch {
      toast.error(t('portfolio.builder.createFailed'))
    } finally {
      setSaving(false)
    }
  }

  const stepIndex = STEPS.indexOf(step)
  const summaryLines: string[] = []
  const addSummary = (label: string, value: string) => { if (value.trim()) summaryLines.push(`${label}: ${value}`) }
  addSummary(t('portfolio.builder.fields.name'), draft.name.trim())
  addSummary(t('portfolio.builder.fields.code'), draft.code.trim())
  addSummary(t('portfolio.builder.fields.legalEntity'), subsidiaryOptions.find((option) => option.value === draft.legalEntityId)?.label ?? '')
  addSummary(t('portfolio.builder.fields.valuation'), t(`portfolio.valuations.${draft.valuation}`))
  if (/^[A-Z]{3}$/.test(draft.currency)) {
    for (const field of ['fixedAmount', 'capAmount', 'budgetAmount', 'thresholdAmount'] as const) {
      if (draft[field] && canonicalDecimal(draft[field], 4) !== null) addSummary(t(`portfolio.builder.fields.${field}`), money(draft[field], { currency: draft.currency }))
    }
  }
  if (draft.percentRate) addSummary(t('portfolio.builder.fields.percentRate'), `${draft.percentRate}%`)
  if (draft.family === 'incentive') {
    if (draft.metric) addSummary(t('portfolio.builder.fields.metric'), t(`portfolio.metrics.${draft.metric}`))
    addSummary(t('portfolio.builder.fields.metricScope'), t(`portfolio.scopes.${draft.metricScope}`))
    const scopeOptions = draft.metricScope === 'department' ? departmentOptions : projectOptions
    for (const option of scopeOptions.filter((option) => draft.scopeIds.includes(option.value))) addSummary(t('portfolio.builder.fields.metricScope'), option.label)
    addSummary(t('portfolio.builder.fields.allocation'), t(`portfolio.allocations.${draft.allocation}`))
    for (const option of accountOptions.filter((option) => draft.sourceAccountIds.includes(option.value))) addSummary(t('portfolio.builder.fields.measuredAccountIds'), option.label)
  }
  addSummary(t('portfolio.builder.fields.effectiveFrom'), draft.effectiveFrom)
  addSummary(t('portfolio.builder.fields.effectiveTo'), draft.effectiveTo)
  addSummary(t('portfolio.builder.fields.frequency'), t(`portfolio.frequencies.${draft.frequency}`))
  if (draft.periodBasis) addSummary(t('portfolio.builder.fields.periodBasis'), t(`portfolio.periodBasis.${draft.periodBasis}`))
  addSummary(t('portfolio.builder.fields.paymentDelayDays'), draft.paymentDelayDays)
  addSummary(t('portfolio.approvalControls.title'), t(`portfolio.approvalControls.modes.${draft.approvalMode}`))
  addSummary(t('portfolio.builder.fields.deliveryMethod'), t(`portfolio.delivery.${draft.deliveryMethod}`))
  addSummary(t('portfolio.builder.fields.payComponent'), payComponentOptions.find((option) => option.value === draft.payComponentId)?.label ?? '')

  return (
    <Drawer
      open
      onClose={() => void closeGuard.close()}
      title={mode === 'edit' ? t('portfolio.builder.editTitle') : t('portfolio.builder.typeTitle', { type: t(`portfolio.cards.${draft.family}.title`) })}
      size="lg"
    >
      <div className="flex flex-col gap-4 p-4">
        <div className="space-y-3">
          <div className="flex items-center gap-2"><Badge variant="secondary">{t(`portfolio.cards.${draft.family}.title`)}</Badge></div>
          <p className="text-sm text-slate-500 dark:text-slate-400">{t(`portfolio.programPurpose.${draft.family}`)}</p>
          <FormSteps steps={STEPS.map((key) => ({ key, label: t(`portfolio.builder.steps.${key}`) }))} current={stepIndex} onChange={(index) => setStep(STEPS[index]!)} label={t('portfolio.builder.stepsLabel')} />
        </div>

        {step === 'offer' ? (
          <fieldset className="flex flex-col gap-4">
            <legend className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {t('portfolio.builder.steps.offer')}
            </legend>
            <div>
              <Label htmlFor="program-builder-code">{t('portfolio.builder.fields.code')}</Label>
              <Input
                id="program-builder-code"
                value={draft.code}
                onChange={(e) => set('code', e.target.value)}
                disabled={mode === 'edit'}
                aria-describedby={errors.code ? 'program-builder-code-error' : undefined}
                aria-invalid={errors.code !== undefined}
              />
              <FieldError id="program-builder-code-error" message={errors.code} />
            </div>
            <div>
              <Label htmlFor="program-builder-name">{t('portfolio.builder.fields.name')}</Label>
              <Input
                id="program-builder-name"
                value={draft.name}
                onChange={(e) => set('name', e.target.value)}
                aria-describedby={errors.name ? 'program-builder-name-error' : undefined}
                aria-invalid={errors.name !== undefined}
              />
              <FieldError id="program-builder-name-error" message={errors.name} />
            </div>
            <div>
              <Label htmlFor="program-builder-description">{t('portfolio.builder.fields.description')}</Label>
              <Textarea id="program-builder-description" value={draft.description} onChange={(e) => set('description', e.target.value)} />
            </div>
          </fieldset>
        ) : null}

        {step === 'eligibility' ? (
          <fieldset className="flex flex-col gap-4">
            <legend className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {t('portfolio.builder.steps.eligibility')}
            </legend>
            <div>
              <FieldError id="program-builder-legalEntityId-error" message={errors.legalEntityId} />
              <Label htmlFor="program-builder-entity">{t('portfolio.builder.fields.legalEntity')}</Label>
              <Select id="program-builder-entity" value={draft.legalEntityId} onChange={(e) => set('legalEntityId', e.target.value)}>
                <option value="">{t('portfolio.builder.allEntities')}</option>
                {subsidiaryOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t('portfolio.builder.entityHint')}</p>
            </div>
            {employmentsTruncated ? (
              <Alert variant="default" className="flex items-start gap-2">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                <span>{t('portfolio.builder.employmentsTruncated')}</span>
              </Alert>
            ) : null}
          </fieldset>
        ) : null}

        {step === 'value' ? (
          <fieldset className="flex flex-col gap-4">
            <legend className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {t('portfolio.builder.steps.value')}
            </legend>
            <div>
              <Label htmlFor="program-builder-currency">{t('portfolio.builder.fields.currency')}</Label>
              <SearchSelect
                id="program-builder-currency"
                value={draft.currency}
                onChange={(value) => set('currency', value)}
                options={enabledCurrencies}
                ariaLabel={t('portfolio.builder.fields.currency')}
                sheetTitle={t('portfolio.builder.fields.currency')}
                placeholder={t('portfolio.builder.chooseCurrency')}
                clearable={false}
                invalid={errors.currency !== undefined}
              />
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t('portfolio.builder.currencyHint')}</p>
              <FieldError id="program-builder-currency-error" message={errors.currency} />
            </div>
            <div>
              <Label htmlFor="program-builder-valuation">{t('portfolio.builder.fields.valuation')}</Label>
              <Select
                id="program-builder-valuation"
                value={draft.valuation}
                onChange={(e) => set('valuation', e.target.value as ProgramDraft['valuation'])}
              >
                <option value="fixed">{t('portfolio.valuations.fixed')}</option>
                {draft.family === 'incentive' || mode === 'edit' && draft.valuation === 'percent' ? <option value="percent">{t('portfolio.valuations.percent')}</option> : null}
                {draft.family === 'incentive' || mode === 'edit' && draft.valuation === 'pool' ? <option value="pool">{t('portfolio.valuations.pool')}</option> : null}
              </Select>
            </div>
            {draft.valuation === 'fixed' ? (
              <div>
                <Label htmlFor="program-builder-fixed">{t('portfolio.builder.fields.fixedAmount')}</Label>
                <Input
                  id="program-builder-fixed"
                  inputMode="decimal"
                  value={draft.fixedAmount}
                  onChange={(e) => set('fixedAmount', e.target.value)}
                  aria-describedby={errors.fixedAmount ? 'program-builder-fixedAmount-error' : undefined}
                  aria-invalid={errors.fixedAmount !== undefined}
                />
                <FieldError id="program-builder-fixedAmount-error" message={errors.fixedAmount} />
              </div>
            ) : null}
            {draft.valuation === 'percent' ? (
              <div>
                <Label htmlFor="program-builder-percent">{t('portfolio.builder.fields.percentRate')}</Label>
                <Input
                  id="program-builder-percent"
                  inputMode="decimal"
                  value={draft.percentRate}
                  onChange={(e) => set('percentRate', e.target.value)}
                  aria-describedby={errors.percentRate ? 'program-builder-percentRate-error' : undefined}
                  aria-invalid={errors.percentRate !== undefined}
                />
                <FieldError id="program-builder-percentRate-error" message={errors.percentRate} />
              </div>
            ) : null}
            {draft.valuation === 'pool' ? (
              <div>
                <Label htmlFor="program-builder-budget">{t('portfolio.builder.fields.budgetAmount')}</Label>
                <Input
                  id="program-builder-budget"
                  inputMode="decimal"
                  value={draft.budgetAmount}
                  onChange={(e) => set('budgetAmount', e.target.value)}
                  aria-describedby={errors.budgetAmount ? 'program-builder-budgetAmount-error' : undefined}
                  aria-invalid={errors.budgetAmount !== undefined}
                />
                <FieldError id="program-builder-budgetAmount-error" message={errors.budgetAmount} />
              </div>
            ) : null}
            {draft.family === 'incentive' ? (
              <>
                <div>
                  <Label htmlFor="program-builder-metric">{t('portfolio.builder.fields.metric')}</Label>
                  <Select
                    id="program-builder-metric"
                    value={draft.metric}
                    onChange={(e) => set('metric', e.target.value as ProgramDraft['metric'])}
                  >
                    <option value="revenue">{t('portfolio.metrics.revenue')}</option>
                    <option value="gross_profit">{t('portfolio.metrics.gross_profit')}</option>
                    <option value="net_profit">{t('portfolio.metrics.net_profit')}</option>
                    <option value="approved_hours">{t('portfolio.metrics.approved_hours')}</option>
                  </Select>
                  <FieldError id="program-builder-metric-error" message={errors.metric} />
                </div>
                <div>
                  <Label htmlFor="program-builder-scope">{t('portfolio.builder.fields.metricScope')}</Label>
                  <Select
                    id="program-builder-scope"
                    value={draft.metricScope}
                    onChange={(e) => { set('metricScope', e.target.value as ProgramDraft['metricScope']); set('scopeIds', []) }}
                  >
                    <option value="company">{t('portfolio.scopes.company')}</option>
                    <option value="department">{t('portfolio.scopes.department')}</option>
                    <option value="project">{t('portfolio.scopes.project')}</option>
                  </Select>
                </div>
                {draft.metricScope === 'department' ? (
                  <OptionMultiPicker
                    id="program-builder-departments"
                    label={t('portfolio.builder.fields.departments')}
                    options={departmentOptions}
                    selected={draft.scopeIds}
                    onChange={(scopeIds) => set('scopeIds', scopeIds)}
                    searchPlaceholder={t('portfolio.builder.searchDepartments')}
                    emptyLabel={t('portfolio.builder.noDepartments')}
                    errorId="program-builder-scopeIds-error"
                    error={errors.scopeIds}
                  />
                ) : null}
                {draft.metricScope === 'project' ? (
                  <OptionMultiPicker
                    id="program-builder-projects"
                    label={t('portfolio.builder.fields.projects')}
                    options={projectOptions}
                    selected={draft.scopeIds}
                    onChange={(scopeIds) => set('scopeIds', scopeIds)}
                    searchPlaceholder={t('portfolio.builder.searchProjects')}
                    emptyLabel={t('portfolio.builder.noProjects')}
                    errorId="program-builder-scopeIds-error"
                    error={errors.scopeIds}
                  />
                ) : null}
              </>
            ) : null}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="program-builder-cap">{t('portfolio.builder.fields.capAmount')}</Label>
                <Input id="program-builder-cap" inputMode="decimal" value={draft.capAmount} onChange={(e) => set('capAmount', e.target.value)} aria-describedby={errors.capAmount ? 'program-builder-capAmount-error' : undefined} aria-invalid={errors.capAmount !== undefined} />
                <FieldError id="program-builder-capAmount-error" message={errors.capAmount} />
              </div>
              <div>
                <Label htmlFor="program-builder-threshold">{t('portfolio.builder.fields.thresholdAmount')}</Label>
                <Input
                  id="program-builder-threshold"
                  inputMode="decimal"
                  value={draft.thresholdAmount}
                  onChange={(e) => set('thresholdAmount', e.target.value)}
                  aria-describedby={errors.thresholdAmount ? 'program-builder-thresholdAmount-error' : undefined}
                  aria-invalid={errors.thresholdAmount !== undefined}
                />
                <FieldError id="program-builder-thresholdAmount-error" message={errors.thresholdAmount} />
              </div>
            </div>
          </fieldset>
        ) : null}

        {step === 'timing' ? (
          <fieldset className="flex flex-col gap-4">
            <legend className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {t('portfolio.builder.steps.timing')}
            </legend>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="program-builder-from">{t('portfolio.builder.fields.effectiveFrom')}</Label>
                <Input
                  id="program-builder-from"
                  type="date"
                  value={draft.effectiveFrom}
                  onChange={(e) => set('effectiveFrom', e.target.value)}
                  aria-describedby={errors.effectiveFrom ? 'program-builder-effectiveFrom-error' : undefined}
                  aria-invalid={errors.effectiveFrom !== undefined}
                />
                <FieldError id="program-builder-effectiveFrom-error" message={errors.effectiveFrom} />
              </div>
              <div>
                <Label htmlFor="program-builder-to">{t('portfolio.builder.fields.effectiveTo')}</Label>
                <Input
                  id="program-builder-to"
                  type="date"
                  value={draft.effectiveTo}
                  onChange={(e) => set('effectiveTo', e.target.value)}
                  aria-describedby={errors.effectiveTo ? 'program-builder-effectiveTo-error' : undefined}
                  aria-invalid={errors.effectiveTo !== undefined}
                />
                <FieldError id="program-builder-effectiveTo-error" message={errors.effectiveTo} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="program-builder-frequency">{t('portfolio.builder.fields.frequency')}</Label>
                <Select
                  id="program-builder-frequency"
                  value={draft.frequency}
                  onChange={(e) => set('frequency', e.target.value as ProgramDraft['frequency'])}
                >
                  <option value="monthly">{t('portfolio.frequencies.monthly')}</option>
                  <option value="quarterly">{t('portfolio.frequencies.quarterly')}</option>
                  <option value="annual">{t('portfolio.frequencies.annual')}</option>
                  {draft.family === 'incentive' && draft.metricScope === 'project' || draft.frequency === 'project_complete' ? <option value="project_complete" disabled={draft.family !== 'incentive' || draft.metricScope !== 'project'}>{t('portfolio.frequencies.project_complete')}</option> : null}
                  <option value="manual">{t('portfolio.frequencies.manual')}</option>
                </Select>
              </div>
              <div>
                <Label htmlFor="program-builder-delay">{t('portfolio.builder.fields.paymentDelayDays')}</Label>
                <Input
                  id="program-builder-delay"
                  inputMode="numeric"
                  value={draft.paymentDelayDays}
                  onChange={(e) => set('paymentDelayDays', e.target.value)}
                  aria-describedby={errors.paymentDelayDays ? 'program-builder-paymentDelayDays-error' : undefined}
                  aria-invalid={errors.paymentDelayDays !== undefined}
                />
                <FieldError id="program-builder-paymentDelayDays-error" message={errors.paymentDelayDays} />
              </div>
            </div>
            {draft.frequency === 'quarterly' || draft.frequency === 'annual' ? (
              <div>
                <Label htmlFor="program-builder-basis">{t('portfolio.builder.fields.periodBasis')}</Label>
                <Select
                  id="program-builder-basis"
                  value={draft.periodBasis}
                  onChange={(e) => set('periodBasis', e.target.value as ProgramDraft['periodBasis'])}
                  aria-describedby={errors.periodBasis ? 'program-builder-periodBasis-error' : undefined}
                  aria-invalid={errors.periodBasis !== undefined}
                >
                  <option value="">{t('portfolio.builder.chooseBasis')}</option>
                  <option value="calendar">{t('portfolio.periodBasis.calendar')}</option>
                  <option value="fiscal">{t('portfolio.periodBasis.fiscal')}</option>
                </Select>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t('portfolio.builder.basisHint')}</p>
                <FieldError id="program-builder-periodBasis-error" message={errors.periodBasis} />
              </div>
            ) : null}
          </fieldset>
        ) : null}

        {step === 'controls' ? (
          <fieldset className="flex flex-col gap-4">
            <legend className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {t('portfolio.builder.steps.controls')}
            </legend>
            <div className="flex flex-col gap-2 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
              <Label htmlFor="program-builder-approvalMode">{t('portfolio.approvalControls.title')}</Label>
              <Select id="program-builder-approvalMode" value={draft.approvalMode} onChange={(event) => set('approvalMode', event.target.value as ProgramDraft['approvalMode'])}>
                <option value="none">{t('portfolio.approvalControls.modes.none')}</option>
                <option value="flows">{t('portfolio.approvalControls.modes.flows')}</option>
              </Select>
              {draft.approvalMode === 'flows' ? <>
                <p className="text-sm text-slate-500 dark:text-slate-400">{t('portfolio.approvalControls.hint')}</p>
                {canConfigureApprovalPolicies ? <div><Button asChild variant="outline" size="sm"><Link href="/admin/flows" target="_blank" rel="noopener noreferrer">{t('portfolio.approvalControls.openFlows')}</Link></Button></div> : <p className="text-sm text-slate-500 dark:text-slate-400">{t('portfolio.approvalControls.administratorRemedy')}</p>}
              </> : <p className="text-sm text-slate-500 dark:text-slate-400">{t('portfolio.approvalControls.noneHint')}</p>}
            </div>
            {draft.family === 'incentive' ? <div>
              <Label htmlFor="program-builder-allocation">{t('portfolio.builder.fields.allocation')}</Label>
              <Select
                id="program-builder-allocation"
                value={draft.allocation}
                onChange={(e) => set('allocation', e.target.value as ProgramDraft['allocation'])}
              >
                <option value="equal">{t('portfolio.allocations.equal')}</option>
                <option value="hours">{t('portfolio.allocations.hours')}</option>
                <option value="role">{t('portfolio.allocations.role')}</option>
              </Select>
            </div> : null}
            {draft.family === 'incentive' && draft.metric !== '' && draft.metric !== 'approved_hours' ? (
              <>
                <OptionMultiPicker
                  id="program-builder-sources"
                  label={t('portfolio.builder.fields.measuredAccountIds')}
                  options={accountOptions}
                  selected={draft.sourceAccountIds}
                  onChange={(sourceAccountIds) => set('sourceAccountIds', sourceAccountIds)}
                  searchPlaceholder={t('portfolio.builder.searchAccounts')}
                  emptyLabel={t('portfolio.builder.noAccounts')}
                  errorId="program-builder-sourceAccountIds-error"
                  error={errors.sourceAccountIds}
                />
                <p className="-mt-2 text-xs text-slate-500 dark:text-slate-400">{t('portfolio.builder.measuredHint')}</p>
                {accountOptions.length === 0 ? <Alert className="flex flex-col gap-2">
                  <p>{t('portfolio.builder.accountsPrerequisite')}</p>
                  <Button asChild variant="outline" size="sm"><Link href="/accounts" target="_blank" rel="noopener noreferrer">{t('portfolio.builder.openAccounts')}</Link></Button>
                  <Button variant="outline" size="sm" onClick={() => router.refresh()}>{t('portfolio.builder.refreshOptions')}</Button>
                </Alert> : null}
              </>
            ) : (
              <p className="text-xs text-slate-500 dark:text-slate-400">{t('portfolio.builder.payComponentMapsValue')}</p>
            )}
          </fieldset>
        ) : null}

        {step === 'delivery' ? (
          <fieldset className="flex flex-col gap-4">
            <legend className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {t('portfolio.builder.steps.delivery')}
            </legend>
            <p className="text-sm text-slate-500 dark:text-slate-400">{t('portfolio.scopeHint')}</p>
            <div>
              <Label htmlFor="program-builder-delivery">{t('portfolio.builder.fields.deliveryMethod')}</Label>
              <Select
                id="program-builder-delivery"
                value={draft.deliveryMethod}
                onChange={(e) => { set('deliveryMethod', e.target.value as ProgramDraft['deliveryMethod']); set('payComponentId', '') }}
              >
                <option value="payroll">{t('portfolio.delivery.payroll')}</option>
                <option value="external">{t('portfolio.delivery.external')}</option>
              </Select>
              <FieldError id="program-builder-payComponentId-error" message={errors.payComponentId} />
            </div>
            <div>
                <Label htmlFor="program-builder-component">{t('portfolio.builder.fields.payComponent')}</Label>
                <Select
                  id="program-builder-component"
                  value={draft.payComponentId}
                  onChange={(e) => set('payComponentId', e.target.value)}
                  aria-describedby={errors.payComponentId ? 'program-builder-payComponentId-error2' : undefined}
                  aria-invalid={errors.payComponentId !== undefined}
                >
                  <option value="">{t('portfolio.builder.chooseComponent')}</option>
                  {deliveryComponents.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
                <FieldError id="program-builder-payComponentId-error2" message={errors.payComponentId} />
                {deliveryComponents.length === 0 ? <Alert className="mt-2 flex flex-col gap-2">
                  <p>{t('portfolio.builder.componentPrerequisite')}</p>
                  <Button asChild variant="outline" size="sm"><Link href={'/admin/setup/payroll?tab=components' as never} target="_blank" rel="noopener noreferrer">{t('portfolio.builder.openPayrollSetup')}</Link></Button>
                  <Button variant="outline" size="sm" onClick={() => router.refresh()}>{t('portfolio.builder.refreshOptions')}</Button>
                </Alert> : null}
              </div>
            {draft.deliveryMethod === 'external' ? <p className="text-xs text-slate-500 dark:text-slate-400">{t('portfolio.builder.externalHint')}</p> : null}
          </fieldset>
        ) : null}

        {step === 'review' ? (
          <div className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('portfolio.builder.reviewTitle')}</h3>
            {summaryLines.length === 0 ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">{t('portfolio.builder.reviewEmpty')}</p>
            ) : (
              <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
                {summaryLines.map((line) => (
                  <li key={line} className="px-3 py-1.5 text-sm text-slate-700 dark:text-slate-200">
                    {line}
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-slate-500 dark:text-slate-400">{t('portfolio.builder.reviewHint')}</p>
            {mode === 'edit' ? (
              <div>
                <Label htmlFor="program-builder-reason">{t('portfolio.builder.fields.reason')}</Label>
                <Textarea
                  id="program-builder-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder={t('portfolio.builder.reasonPlaceholder')}
                  required
                />
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="flex justify-between gap-2">
          <Button variant="outline" onClick={() => void closeGuard.close()}>
            {t('portfolio.builder.cancel')}
          </Button>
          <div className="flex gap-2">
            {stepIndex > 0 ? (
              <Button variant="outline" onClick={() => setStep(STEPS[stepIndex - 1] ?? 'offer')}>
                {t('portfolio.builder.back')}
              </Button>
            ) : null}
            {step !== 'review' ? (
              <Button onClick={next}>{t('portfolio.builder.next')}</Button>
            ) : (
              <Button disabled={saving} onClick={save}>
                {mode === 'edit' ? t('portfolio.builder.saveChanges') : t('portfolio.builder.create')}
              </Button>
            )}
          </div>
        </div>
      </div>
    </Drawer>
  )
}

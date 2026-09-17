'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import {
  ArrowLeft,
  ArrowRight,
  BookPlus,
  CalendarClock,
  Check,
  Loader2,
  Sparkles,
  Split,
  X,
} from 'lucide-react'
import { Input, Label, SearchSelect, cn } from '@openbooks/ui'
import { useBusinessToday } from '../../../../../components/business-date-provider'
import { useMoney } from '../../../../../components/money-provider'
import { WizardShell } from '../wizard/WizardShell'
import { apiError, definitionPayload } from './rule-drawer-form'
import {
  BUILTIN_TARGET_DIMENSIONS,
  SOURCE_FILTER_KEYS,
  WIZARD_DOCUMENT_KINDS,
  WIZARD_STEPS,
  allowsUntagged,
  defaultSourceFilters,
  defaultWizardDraft,
  emptySourceFilter,
  filledTargets,
  hrefWithRule,
  keyFromName,
  knownDriverDimension,
  nextTargetWeight,
  previewSplitAmounts,
  trimDecimal,
  wizardDefinitionForm,
  wizardStepComplete,
  wizardTargetPayload,
  wizardTargetPercents,
  wizardUsesExplicitTargets,
  type AllocationWizardMode,
  type SourceFilter,
  type SourceFilterKey,
  type SourceMatchMode,
  type TargetDimension,
  type WizardDocumentKind,
  type WizardDraft,
  type WizardDriver,
} from './rule-wizard'

interface Option {
  id: string
  label: string
}

interface SegmentOption {
  key: string
  label: string
  values: Option[]
}

interface PickerOptions {
  departments: Option[]
  locations: Option[]
  classes: Option[]
  projects: Option[]
  subsidiaries: Option[]
  parties: Option[]
  items: Option[]
  segments: SegmentOption[]
}

/**
 * Guided create — the house WizardShell (payroll onboarding / org setup).
 * Answers map onto the same rule version + targets the Definition tab edits,
 * so graduating to the drawer never means re-learning.
 */
export function AllocationRuleWizard({ closeHref }: { closeHref: string }) {
  const t = useTranslations('allocations')
  const tc = useTranslations('common')
  const router = useRouter()
  const today = useBusinessToday()
  const { money } = useMoney()
  const [stepIdx, setStepIdx] = useState(0)
  const [draft, setDraft] = useState<WizardDraft>(defaultWizardDraft)
  const [keyTouched, setKeyTouched] = useState(false)
  const [sourceFiltersTouched, setSourceFiltersTouched] = useState(false)
  const [options, setOptions] = useState<PickerOptions | null>(null)
  const [drivers, setDrivers] = useState<WizardDriver[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [requestKey, setRequestKey] = useState(0)

  const step = WIZARD_STEPS[stepIdx] ?? 'when'

  useEffect(() => {
    const controller = new AbortController()
    let live = true
    const load = async () => {
      setLoadError(null)
      const [optionsRes, driversRes] = await Promise.all([
        fetch('/api/allocations/options', { signal: controller.signal }),
        fetch('/api/allocations/drivers', { signal: controller.signal }),
      ])
      if (!live) return
      if (!optionsRes.ok) {
        setLoadError(t('wizard.loadFailed'))
        return
      }
      const payload = (await optionsRes.json()) as Record<string, unknown>
      const rawSegments = Array.isArray(payload['segments']) ? (payload['segments'] as SegmentOption[]) : []
      setOptions({
        departments: asOptions(payload['departments']),
        locations: asOptions(payload['locations']),
        classes: asOptions(payload['classes']),
        projects: asOptions(payload['projects']),
        subsidiaries: asOptions(payload['subsidiaries']),
        parties: asOptions(payload['parties']),
        items: asOptions(payload['items']),
        segments: rawSegments
          .filter((segment) => typeof segment?.key === 'string' && typeof segment.label === 'string')
          .map((segment) => ({ key: segment.key, label: segment.label, values: asOptions(segment.values) })),
      })
      if (driversRes.ok) {
        const body = (await driversRes.json()) as { drivers?: WizardDriver[] }
        setDrivers((body.drivers ?? []).filter((driver) => driver.isActive && knownDriverDimension(driver.dimension)))
      }
    }
    void load().catch((error: unknown) => {
      if (live && !(error instanceof DOMException && error.name === 'AbortError')) {
        setLoadError(t('wizard.loadFailed'))
      }
    })
    return () => {
      live = false
      controller.abort()
    }
  }, [requestKey, t])

  const set = <K extends keyof WizardDraft>(key: K, value: WizardDraft[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  const chooseMode = (mode: AllocationWizardMode) => {
    setDraft((prev) => ({
      ...prev,
      mode,
      sourceFilters: sourceFiltersTouched ? prev.sourceFilters : defaultSourceFilters(mode),
    }))
  }

  const chooseSplit = (splitKind: WizardDraft['splitKind']) => {
    setDraft((prev) => ({
      ...prev,
      splitKind,
      targets: prev.targets.map((row, index) => ({
        ...row,
        weight:
          splitKind === 'percent'
            ? (['10', '20', '30', '40'][index] ?? '10')
            : splitKind === 'ratio'
              ? String(index + 1)
              : row.weight,
      })),
    }))
  }

  const setName = (name: string) => {
    setDraft((prev) => ({
      ...prev,
      name,
      key: keyTouched ? prev.key : keyFromName(name),
    }))
  }

  const dimensionOptions = (dimension: string): Option[] => {
    if (!options) return []
    if (dimension === 'department') return options.departments
    if (dimension === 'location') return options.locations
    if (dimension === 'class') return options.classes
    if (dimension === 'project') return options.projects
    if (dimension === 'subsidiary') return options.subsidiaries
    if (dimension === 'party') return options.parties
    if (dimension === 'item') return options.items
    if (dimension.startsWith('extra:')) {
      const key = dimension.slice('extra:'.length)
      return options.segments.find((segment) => segment.key === key)?.values ?? []
    }
    return []
  }

  const dimLabel = (dimension: string): string => {
    if (dimension === 'department') return t('rules.definition.filters.department')
    if (dimension === 'location') return t('rules.definition.filters.location')
    if (dimension === 'class') return t('rules.definition.filters.class')
    if (dimension === 'project') return t('rules.definition.filters.project')
    if (dimension === 'subsidiary') return t('rules.definition.filters.subsidiary')
    if (dimension === 'party') return t('rules.definition.filters.party')
    if (dimension === 'item') return t('rules.definition.filters.item')
    if (dimension.startsWith('extra:')) {
      const key = dimension.slice('extra:'.length)
      return options?.segments.find((segment) => segment.key === key)?.label ?? key
    }
    return dimension
  }

  const targetDimensions = ((): { id: TargetDimension; label: string }[] => {
    if (!options) return BUILTIN_TARGET_DIMENSIONS.map((id) => ({ id, label: id }))
    return [
      ...BUILTIN_TARGET_DIMENSIONS.map((id) => ({ id, label: dimLabel(id) })),
      ...options.segments.map((segment) => ({ id: `extra:${segment.key}` as const, label: segment.label })),
    ]
  })()

  const setSourceFilter = (key: SourceFilterKey, filter: SourceFilter) => {
    setSourceFiltersTouched(true)
    setDraft((prev) => ({ ...prev, sourceFilters: { ...prev.sourceFilters, [key]: filter } }))
  }

  const setExtraFilter = (key: string, filter: SourceFilter) => {
    setSourceFiltersTouched(true)
    setDraft((prev) => ({ ...prev, sourceExtraDims: { ...prev.sourceExtraDims, [key]: filter } }))
  }

  const selectedDriver = drivers.find((driver) => driver.id === draft.driverId) ?? null
  const canNext = wizardStepComplete(step, draft)
  const explicit = wizardUsesExplicitTargets(draft)
  const filled = filledTargets(draft)
  const previewWeights = filled.map((row) => row.weight)
  const previewAmounts = previewWeights.length >= 2 ? previewSplitAmounts('1000.00', previewWeights) : []
  const previewPercents = ((): string[] => {
    if (!explicit || filled.length < 2) return []
    if (draft.splitKind === 'percent' && !wizardStepComplete('targets', draft)) return []
    try {
      return wizardTargetPercents(draft).map(trimDecimal)
    } catch {
      return []
    }
  })()

  const close = () => {
    router.push(closeHref as never)
  }

  const skipGuide = async () => {
    if (busy) return
    setBusy(true)
    try {
      const key = draft.key !== '' && keyFromName(draft.name) ? draft.key : keyFromName(draft.name || 'allocation')
      const name = draft.name.trim() === '' ? t('wizard.untitled') : draft.name.trim()
      const { status, body } = await postJson('/api/allocations/rules', {
        key: key || 'allocation',
        name,
        mode: draft.mode,
        description: draft.description === '' ? null : draft.description,
      })
      if (status !== 201) {
        toast.error(apiError(status, body, t('wizard.createFailed')).message)
        return
      }
      const id = (body as { rule?: { id?: string } })?.rule?.id
      if (typeof id === 'string' && id !== '') {
        router.push(hrefWithRule(closeHref, id) as never)
        return
      }
      close()
    } finally {
      setBusy(false)
    }
  }

  const finish = async () => {
    if (busy || !wizardStepComplete('review', draft)) return
    setBusy(true)
    try {
      const created = await postJson('/api/allocations/rules', {
        key: draft.key,
        name: draft.name.trim(),
        mode: draft.mode,
        description: draft.description === '' ? null : draft.description,
      })
      if (created.status !== 201) {
        toast.error(apiError(created.status, created.body, t('wizard.createFailed')).message)
        return
      }
      const ruleId = (created.body as { rule?: { id?: string } })?.rule?.id
      const versionId = (created.body as { version?: { id?: string } })?.version?.id
      let revision = (created.body as { version?: { revision?: string } })?.version?.revision
      if (typeof ruleId !== 'string' || typeof versionId !== 'string' || typeof revision !== 'string') {
        toast.error(t('wizard.createFailed'))
        return
      }
      const versionUrl = `/api/allocations/rules/${encodeURIComponent(ruleId)}/versions/${encodeURIComponent(versionId)}`
      const form = wizardDefinitionForm(draft, today, selectedDriver)
      const patched = await postJson(versionUrl, definitionPayload(form, revision), 'PATCH')
      if (patched.status !== 200) {
        toast.error(apiError(patched.status, patched.body, t('wizard.createFailed')).message)
        router.push(hrefWithRule(closeHref, ruleId) as never)
        return
      }
      revision = (patched.body as { version?: { revision?: string } })?.version?.revision ?? revision
      if (explicit) {
        const replaced = await postJson(`${versionUrl}/targets`, {
          targets: wizardTargetPayload(draft),
          expectedRevision: revision,
        }, 'PUT')
        if (replaced.status !== 200) {
          toast.error(apiError(replaced.status, replaced.body, t('wizard.createFailed')).message)
          router.push(hrefWithRule(closeHref, ruleId) as never)
          return
        }
        revision = (replaced.body as { revision?: string })?.revision ?? revision
      }
      if (draft.publishNow) {
        const published = await postJson(`${versionUrl}/publish`, {}, 'POST')
        if (published.status !== 200) {
          const failure = apiError(published.status, published.body, t('wizard.publishFailed'))
          const problems = (published.body as { problems?: { message?: string }[] } | null)?.problems ?? []
          toast.error(problems[0]?.message ?? failure.message)
          router.push(hrefWithRule(closeHref, ruleId) as never)
          return
        }
        toast.success(t('wizard.published'))
      } else {
        toast.success(t('wizard.created'))
      }
      router.push(hrefWithRule(closeHref, ruleId) as never)
    } finally {
      setBusy(false)
    }
  }

  const kindLabel = (kind: WizardDocumentKind): string => {
    switch (kind) {
      case 'vendor_bill':
        return tc('transactionTypes.vendorBill')
      case 'vendor_credit':
        return tc('transactionTypes.vendorCredit')
      case 'customer_invoice':
        return tc('transactionTypes.customerInvoice')
      case 'customer_credit':
        return tc('transactionTypes.customerCredit')
      case 'journal':
        return tc('transactionTypes.journal')
      case 'check':
        return tc('transactionTypes.check')
      case 'card_charge':
        return tc('transactionTypes.cardCharge')
      case 'expense_report':
        return tc('transactionTypes.expenseReport')
    }
  }

  const modeLabel = (mode: AllocationWizardMode): string => {
    if (mode === 'entry') return t('rules.modes.entry')
    if (mode === 'post') return t('rules.modes.post')
    return t('rules.modes.period')
  }

  return (
    <WizardShell
      testId="allocation-rule-wizard"
      stepKey={options ? step : 'loading'}
      progress={options ? { index: stepIdx, total: WIZARD_STEPS.length } : null}
      skip={!busy ? { label: tc('actions.close'), onClick: close } : null}
      footer={
        options
          ? {
              back:
                stepIdx > 0
                  ? {
                      label: (
                        <>
                          <ArrowLeft size={16} /> {tc('actions.back')}
                        </>
                      ),
                      onClick: () => setStepIdx((idx) => Math.max(0, idx - 1)),
                      disabled: busy,
                    }
                  : null,
              primary:
                step === 'review'
                  ? {
                      label: (
                        <>
                          <Sparkles size={16} /> {busy ? t('wizard.creating') : t('wizard.finish')}
                        </>
                      ),
                      onClick: () => void finish(),
                      disabled: busy || !canNext,
                    }
                  : {
                      label: (
                        <>
                          {tc('actions.next')} <ArrowRight size={16} />
                        </>
                      ),
                      onClick: () => setStepIdx((idx) => Math.min(WIZARD_STEPS.length - 1, idx + 1)),
                      disabled: !canNext || busy,
                    },
            }
          : null
      }
    >
      {!options && !loadError ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Loader2 className="animate-spin text-teal-500" size={40} />
        </div>
      ) : null}
      {loadError ? (
        <div className="space-y-3">
          <p className="text-sm text-red-700 dark:text-red-300">{loadError}</p>
          <button
            type="button"
            className="text-sm font-medium text-teal-700 underline dark:text-teal-300"
            onClick={() => setRequestKey((key) => key + 1)}
          >
            {tc('actions.retry')}
          </button>
        </div>
      ) : null}
      {options && step === 'when' ? (
        <StepFrame title={t('wizard.when.title')} description={t('wizard.when.description')}>
          <ChoiceCard
            active={draft.mode === 'entry'}
            icon={<Split size={18} />}
            title={t('wizard.when.entry.title')}
            description={t('wizard.when.entry.description')}
            example={t('wizard.when.entry.example')}
            onClick={() => chooseMode('entry')}
          />
          <ChoiceCard
            active={draft.mode === 'period'}
            icon={<CalendarClock size={18} />}
            title={t('wizard.when.period.title')}
            description={t('wizard.when.period.description')}
            example={t('wizard.when.period.example')}
            onClick={() => chooseMode('period')}
          />
          <ChoiceCard
            active={draft.mode === 'post'}
            icon={<BookPlus size={18} />}
            title={t('wizard.when.post.title')}
            description={t('wizard.when.post.description')}
            example={t('wizard.when.post.example')}
            badge={t('wizard.when.advanced')}
            onClick={() => chooseMode('post')}
          />
          <button type="button" className="text-xs font-medium text-slate-500 underline hover:text-slate-700 dark:hover:text-slate-300" onClick={() => void skipGuide()}>
            {t('wizard.skipGuide')}
          </button>
        </StepFrame>
      ) : null}
      {options && step === 'source' ? (
        <StepFrame title={t('wizard.source.title')} description={t('wizard.source.description')}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('rules.general.name')}>
              <Input value={draft.name} aria-label={t('rules.general.name')} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label={t('rules.general.key')} hint={t('rules.general.keyHint')}>
              <Input
                value={draft.key}
                aria-label={t('rules.general.key')}
                onChange={(e) => {
                  setKeyTouched(true)
                  set('key', e.target.value)
                }}
              />
            </Field>
          </div>
          <Field label={t('rules.general.description')}>
            <Input value={draft.description} aria-label={t('rules.general.description')} onChange={(e) => set('description', e.target.value)} />
          </Field>
          <div>
            <Label help={t('wizard.source.kindsHint')}>{t('wizard.source.kinds')}</Label>
            <div className="mt-2 flex flex-wrap gap-2">
              {WIZARD_DOCUMENT_KINDS.map((item) => {
                const on = draft.documentKinds.includes(item.kind)
                return (
                  <button
                    key={item.kind}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      set(
                        'documentKinds',
                        on
                          ? draft.documentKinds.filter((kind) => kind !== item.kind)
                          : [...draft.documentKinds, item.kind],
                      )
                    }
                    className={chipClass(on)}
                  >
                    {kindLabel(item.kind)}
                  </button>
                )
              })}
            </div>
            <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">{t('wizard.source.anyKind')}</p>
          </div>
          <div className="space-y-2">
            <Label help={t('wizard.source.filtersHint')}>{t('wizard.source.filters')}</Label>
            <p className="text-xs text-slate-500 dark:text-slate-400">{t('wizard.source.filtersAny')}</p>
            <div className="space-y-2">
              {SOURCE_FILTER_KEYS.map((key) => (
                <SourceFilterRow
                  key={key}
                  label={dimLabel(key)}
                  filter={draft.sourceFilters[key]}
                  values={dimensionOptions(key)}
                  allowUntagged={allowsUntagged(key)}
                  pickLabel={t('wizard.source.pickValue')}
                  noValuesLabel={t('wizard.source.noValues')}
                  modeAny={t('wizard.source.modeAny')}
                  modeUntagged={t('wizard.source.modeUntagged')}
                  modeSpecific={t('wizard.source.modeSpecific')}
                  removeLabel={tc('actions.remove')}
                  onChange={(next) => setSourceFilter(key, next)}
                />
              ))}
              {options.segments.map((segment) => (
                <SourceFilterRow
                  key={`extra:${segment.key}`}
                  label={segment.label}
                  filter={draft.sourceExtraDims[segment.key] ?? emptySourceFilter()}
                  values={segment.values}
                  allowUntagged={false}
                  pickLabel={t('wizard.source.pickValue')}
                  noValuesLabel={t('wizard.source.noValues')}
                  modeAny={t('wizard.source.modeAny')}
                  modeUntagged={t('wizard.source.modeUntagged')}
                  modeSpecific={t('wizard.source.modeSpecific')}
                  removeLabel={tc('actions.remove')}
                  onChange={(next) => setExtraFilter(segment.key, next)}
                />
              ))}
            </div>
          </div>
        </StepFrame>
      ) : null}
      {options && step === 'split' ? (
        <StepFrame title={t('wizard.split.title')} description={t('wizard.split.description')}>
          <ChoiceCard
            active={draft.splitKind === 'ratio'}
            title={t('wizard.split.ratio.title')}
            description={t('wizard.split.ratio.description')}
            example={t('wizard.split.ratio.example')}
            onClick={() => chooseSplit('ratio')}
          />
          <ChoiceCard
            active={draft.splitKind === 'percent'}
            title={t('wizard.split.percent.title')}
            description={t('wizard.split.percent.description')}
            onClick={() => chooseSplit('percent')}
          />
          <ChoiceCard
            active={draft.splitKind === 'driver'}
            title={t('wizard.split.driver.title')}
            description={t('wizard.split.driver.description')}
            disabled={drivers.length === 0}
            onClick={() => drivers.length > 0 && set('splitKind', 'driver')}
          />
          {drivers.length === 0 ? (
            <p className="text-xs text-slate-500 dark:text-slate-400">{t('wizard.split.driverEmpty')}</p>
          ) : null}
          {draft.splitKind === 'driver' && drivers.length > 0 ? (
            <Field label={t('rules.definition.driver')} hint={t('wizard.split.driverHint')}>
              <SearchSelect
                value={draft.driverId}
                onChange={(value) => set('driverId', value ?? '')}
                options={drivers.map((driver) => ({ value: driver.id, label: `${driver.key} · ${driver.name}` }))}
                placeholder={t('rules.definition.driver')}
                sheetTitle={t('rules.definition.driver')}
                ariaLabel={t('rules.definition.driver')}
                clearable
                emptyLabel={t('rules.definition.driver')}
              />
            </Field>
          ) : null}
        </StepFrame>
      ) : null}
      {options && step === 'targets' ? (
        <StepFrame title={t('wizard.targets.title')} description={explicit ? t('wizard.targets.description') : t('wizard.targets.driverDynamicHint')}>
          {explicit ? (
            <>
              <Field label={t('wizard.targets.dimension')}>
                <div className="flex flex-wrap gap-2">
                  {targetDimensions.map((dimension) => (
                    <button
                      key={dimension.id}
                      type="button"
                      aria-pressed={draft.targetDimension === dimension.id}
                      onClick={() =>
                        setDraft((prev) => ({
                          ...prev,
                          targetDimension: dimension.id,
                          targets: prev.targets.map((row) => ({ ...row, valueId: '' })),
                        }))
                      }
                      className={chipClass(draft.targetDimension === dimension.id)}
                    >
                      {dimension.label}
                    </button>
                  ))}
                </div>
              </Field>
              {dimensionOptions(draft.targetDimension).length === 0 ? (
                <p className="text-sm text-slate-500 dark:text-slate-400">{t('wizard.targets.noValues')}</p>
              ) : (
                <div className="space-y-2">
                  {draft.targets.map((row, index) => (
                    <div key={index} className="grid items-end gap-2 sm:grid-cols-[1fr_6rem_5rem_auto]">
                      <Field label={index === 0 ? t('wizard.targets.value') : undefined}>
                        <SearchSelect
                          value={row.valueId}
                          onChange={(value) =>
                            set(
                              'targets',
                              draft.targets.map((current, j) => (j === index ? { ...current, valueId: value ?? '' } : current)),
                            )
                          }
                          options={dimensionOptions(draft.targetDimension).map((item) => ({
                            value: item.id,
                            label: item.label,
                          }))}
                          placeholder={t('wizard.targets.pickValue')}
                          sheetTitle={t('wizard.targets.value')}
                          ariaLabel={t('wizard.targets.value')}
                          clearable
                          emptyLabel={t('wizard.targets.pickValue')}
                        />
                      </Field>
                      <Field label={index === 0 ? (draft.splitKind === 'percent' ? t('wizard.targets.percent') : t('wizard.targets.weight')) : undefined}>
                        <Input
                          value={row.weight}
                          inputMode="decimal"
                          aria-label={draft.splitKind === 'percent' ? t('wizard.targets.percent') : t('wizard.targets.weight')}
                          onChange={(e) =>
                            set(
                              'targets',
                              draft.targets.map((current, j) => (j === index ? { ...current, weight: e.target.value } : current)),
                            )
                          }
                        />
                      </Field>
                      <p className="pb-2 text-xs tabular-nums text-slate-500 dark:text-slate-400">
                        {previewPercents[index] ? `${previewPercents[index]}%` : '—'}
                      </p>
                      <button
                        type="button"
                        className="mb-1 text-xs font-medium text-slate-500 underline hover:text-slate-800 dark:hover:text-slate-200"
                        onClick={() => set('targets', draft.targets.filter((_, j) => j !== index))}
                      >
                        {tc('actions.remove')}
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="text-sm font-medium text-teal-700 hover:underline dark:text-teal-300"
                    onClick={() => set('targets', [...draft.targets, { valueId: '', weight: nextTargetWeight(draft) }])}
                  >
                    {t('wizard.targets.add')}
                  </button>
                </div>
              )}
              {previewAmounts.length > 0 ? (
                <p className="rounded-lg bg-slate-50 p-3 text-xs leading-relaxed text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
                  {t('wizard.targets.example', {
                    amounts: previewAmounts.map((amount) => money(amount)).join(' · '),
                  })}
                </p>
              ) : (
                <p className="text-xs text-slate-500 dark:text-slate-400">{t('wizard.targets.needOne')}</p>
              )}
            </>
          ) : (
            <p className="rounded-lg border border-slate-200 p-4 text-sm text-slate-600 dark:border-slate-700 dark:text-slate-300">
              {t('wizard.targets.driverDynamic', {
                driver: selectedDriver ? `${selectedDriver.key} · ${selectedDriver.name}` : draft.driverId,
                dimension: driverDimensionLabel(t, selectedDriver?.dimension),
              })}
            </p>
          )}
        </StepFrame>
      ) : null}
      {options && step === 'policy' ? (
        <StepFrame title={t('wizard.policy.title')} description={t('wizard.policy.description')}>
          {draft.mode === 'entry' ? (
            <div className="space-y-2">
              <Label>{t('rules.definition.applyPolicy')}</Label>
              {([
                ['automatic', 'applyAutomatic'] as const,
                ['suggest', 'applySuggest'] as const,
                ['manual', 'applyManual'] as const,
              ]).map(([value, copy]) => (
                <ChoiceCard
                  key={value}
                  compact
                  active={draft.applyPolicy === value}
                  title={policyTitle(t, copy)}
                  description={policyHint(t, copy)}
                  onClick={() => set('applyPolicy', value)}
                />
              ))}
            </div>
          ) : null}
          <div className="space-y-2">
            <Label>{t('rules.definition.impact')}</Label>
            <ChoiceCard
              compact
              active={draft.impact === 'reclass'}
              title={t('wizard.policy.impactReclass')}
              description={t('wizard.policy.impactReclassHint')}
              onClick={() => set('impact', 'reclass')}
            />
            <ChoiceCard
              compact
              active={draft.impact === 'net_zero_pair'}
              title={t('wizard.policy.impactNetZero')}
              description={t('wizard.policy.impactNetZeroHint')}
              onClick={() => set('impact', 'net_zero_pair')}
            />
          </div>
          {draft.mode === 'period' ? (
            <>
              <div className="space-y-2">
                <Label>{t('rules.definition.sourceMeasure')}</Label>
                <ChoiceCard
                  compact
                  active={draft.sourceMeasure === 'period_activity'}
                  title={t('rules.definition.sourceMeasures.period_activity')}
                  description={t('wizard.policy.periodActivityHint')}
                  onClick={() => set('sourceMeasure', 'period_activity')}
                />
                <ChoiceCard
                  compact
                  active={draft.sourceMeasure === 'period_end_balance'}
                  title={t('rules.definition.sourceMeasures.period_end_balance')}
                  description={t('wizard.policy.periodBalanceHint')}
                  onClick={() => set('sourceMeasure', 'period_end_balance')}
                />
              </div>
              <div className="space-y-2">
                <Label>{t('rules.definition.runPolicy')}</Label>
                <ChoiceCard
                  compact
                  active={draft.runPolicy === 'manual'}
                  title={t('rules.definition.runPolicies.manual')}
                  description={t('wizard.policy.runManualHint')}
                  onClick={() => set('runPolicy', 'manual')}
                />
                <ChoiceCard
                  compact
                  active={draft.runPolicy === 'auto_preview'}
                  title={t('rules.definition.runPolicies.auto_preview')}
                  description={t('wizard.policy.runAutoPreviewHint')}
                  onClick={() => set('runPolicy', 'auto_preview')}
                />
              </div>
            </>
          ) : null}
        </StepFrame>
      ) : null}
      {options && step === 'review' ? (
        <StepFrame title={t('wizard.review.title')} description={t('wizard.review.description')}>
          <ul className="space-y-2 text-sm text-slate-700 dark:text-slate-200">
            <ReviewLine>{t('wizard.review.when', { mode: modeLabel(draft.mode) })}</ReviewLine>
            <ReviewLine>
              {draft.documentKinds.length === 0
                ? t('wizard.review.sourceAnyKind')
                : t('wizard.review.sourceKinds', { kinds: draft.documentKinds.map(kindLabel).join(', ') })}
            </ReviewLine>
            {sourceReviewLines(t, draft, dimLabel, dimensionOptions).map((line) => (
              <ReviewLine key={line}>{line}</ReviewLine>
            ))}
            <ReviewLine>{splitReview(t, draft, selectedDriver, previewPercents)}</ReviewLine>
            {explicit ? (
              <ReviewLine>
                {t('wizard.review.targets', {
                  dimension: dimLabel(draft.targetDimension),
                  names: filled
                    .map((row) => dimensionOptions(draft.targetDimension).find((item) => item.id === row.valueId)?.label ?? row.valueId)
                    .join(', '),
                })}
              </ReviewLine>
            ) : null}
            <ReviewLine>
              {draft.impact === 'reclass' ? t('wizard.policy.impactReclass') : t('wizard.policy.impactNetZero')}
            </ReviewLine>
          </ul>
          <label className="flex items-start gap-2 rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-700">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
              checked={draft.publishNow}
              onChange={(e) => set('publishNow', e.target.checked)}
            />
            <span>
              <span className="font-medium text-slate-900 dark:text-slate-100">{t('wizard.publishNow')}</span>
              <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">{t('wizard.publishNowHint')}</span>
            </span>
          </label>
          <p className="text-xs text-slate-500 dark:text-slate-400">{t('wizard.advancedAfter')}</p>
        </StepFrame>
      ) : null}
    </WizardShell>
  )
}

async function postJson(
  url: string,
  body: Record<string, unknown>,
  method: 'POST' | 'PATCH' | 'PUT' = 'POST',
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  let parsed: unknown = null
  try {
    parsed = await res.json()
  } catch {
    parsed = null
  }
  return { status: res.status, body: parsed }
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

function Field({ label, hint, children }: { label?: string; hint?: string; children: React.ReactNode }) {
  if (!label) return <div>{children}</div>
  return (
    <div className="space-y-1.5">
      <Label help={hint}>{label}</Label>
      {children}
    </div>
  )
}

function ChoiceCard(props: {
  active: boolean
  title: string
  description: string
  example?: string
  badge?: string
  icon?: React.ReactNode
  compact?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={props.active}
      disabled={props.disabled}
      onClick={props.onClick}
      className={cn(
        'relative flex w-full items-start gap-3 rounded-xl border p-4 text-left transition-colors',
        props.compact && 'p-3',
        props.active
          ? 'border-teal-500 bg-teal-50 ring-2 ring-teal-500/20 dark:border-teal-400 dark:bg-teal-950/40'
          : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800/60',
        props.disabled && 'cursor-not-allowed opacity-60',
      )}
    >
      {props.icon ? (
        <span className={cn('rounded-lg p-2', props.active ? 'bg-teal-600 text-white' : 'bg-slate-100 text-slate-400 dark:bg-slate-800')}>
          {props.icon}
        </span>
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">{props.title}</span>
          {props.badge ? (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              {props.badge}
            </span>
          ) : null}
        </span>
        <span className="mt-0.5 block text-xs leading-relaxed text-slate-500 dark:text-slate-400">{props.description}</span>
        {props.example ? (
          <span className="mt-1.5 block text-xs leading-relaxed text-slate-600 dark:text-slate-300">{props.example}</span>
        ) : null}
      </span>
      {props.active ? (
        <span className="absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded-full bg-teal-500">
          <Check className="text-white" size={12} strokeWidth={3} />
        </span>
      ) : null}
    </button>
  )
}

function ReviewLine({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <Check size={15} className="mt-0.5 shrink-0 text-teal-600 dark:text-teal-400" />
      <span>{children}</span>
    </li>
  )
}

function chipClass(on: boolean): string {
  return cn(
    'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
    on
      ? 'border-teal-500 bg-teal-50 text-teal-800 dark:border-teal-400 dark:bg-teal-950/40 dark:text-teal-200'
      : 'border-slate-200 text-slate-600 hover:border-slate-300 dark:border-slate-700 dark:text-slate-300',
  )
}

function asOptions(value: unknown): Option[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is { id: string; label: string } => {
      return typeof item === 'object' && item !== null && typeof (item as { id?: unknown }).id === 'string' && typeof (item as { label?: unknown }).label === 'string'
    })
    .map((item) => ({ id: item.id, label: item.label }))
}

function SourceFilterRow(props: {
  label: string
  filter: SourceFilter
  values: Option[]
  allowUntagged: boolean
  pickLabel: string
  noValuesLabel: string
  modeAny: string
  modeUntagged: string
  modeSpecific: string
  removeLabel: string
  onChange: (next: SourceFilter) => void
}) {
  const modes: { mode: SourceMatchMode; label: string }[] = [
    { mode: 'any', label: props.modeAny },
    ...(props.allowUntagged ? [{ mode: 'untagged' as const, label: props.modeUntagged }] : []),
    { mode: 'specific', label: props.modeSpecific },
  ]
  const selected = props.values.filter((item) => props.filter.ids.includes(item.id))
  const available = props.values.filter((item) => !props.filter.ids.includes(item.id))
  return (
    <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-slate-800 dark:text-slate-100">{props.label}</span>
        <div className="flex flex-wrap gap-1">
          {modes.map((item) => (
            <button
              key={item.mode}
              type="button"
              aria-pressed={props.filter.mode === item.mode}
              onClick={() => props.onChange({ mode: item.mode, ids: item.mode === 'specific' ? props.filter.ids : [] })}
              className={chipClass(props.filter.mode === item.mode)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      {props.filter.mode === 'specific' ? (
        <div className="mt-2 space-y-2">
          {props.values.length === 0 ? (
            <p className="text-xs text-slate-500 dark:text-slate-400">{props.noValuesLabel}</p>
          ) : (
            <>
              {available.length > 0 ? (
                <SearchSelect
                  value=""
                  onChange={(value) => {
                    if (value === '' || props.filter.ids.includes(value)) return
                    props.onChange({ mode: 'specific', ids: [...props.filter.ids, value] })
                  }}
                  options={available.map((item) => ({ value: item.id, label: item.label }))}
                  placeholder={props.pickLabel}
                  sheetTitle={props.label}
                  ariaLabel={props.label}
                />
              ) : null}
              {selected.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {selected.map((item) => (
                    <span
                      key={item.id}
                      className="inline-flex items-center gap-1 rounded-full bg-teal-50 px-2 py-0.5 text-xs font-medium text-teal-800 dark:bg-teal-950/40 dark:text-teal-200"
                    >
                      {item.label}
                      <button
                        type="button"
                        aria-label={`${props.removeLabel} ${item.label}`}
                        className="text-teal-600 hover:text-teal-900 dark:text-teal-300"
                        onClick={() =>
                          props.onChange({ mode: 'specific', ids: props.filter.ids.filter((id) => id !== item.id) })
                        }
                      >
                        <X size={12} />
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}

function sourceReviewLines(
  t: (key: string, values?: Record<string, string>) => string,
  draft: WizardDraft,
  labelFor: (dimension: string) => string,
  valuesFor: (dimension: string) => Option[],
): string[] {
  const lines: string[] = []
  for (const key of SOURCE_FILTER_KEYS) {
    const filter = draft.sourceFilters[key]
    if (filter.mode === 'any') continue
    if (filter.mode === 'untagged') {
      lines.push(t('wizard.review.sourceUntagged', { dimension: labelFor(key) }))
      continue
    }
    lines.push(
      t('wizard.review.sourceValues', {
        dimension: labelFor(key),
        values: filter.ids.map((id) => valuesFor(key).find((item) => item.id === id)?.label ?? id).join(', '),
      }),
    )
  }
  for (const [key, filter] of Object.entries(draft.sourceExtraDims)) {
    if (filter.mode !== 'specific' || filter.ids.length === 0) continue
    const dimension = `extra:${key}`
    lines.push(
      t('wizard.review.sourceValues', {
        dimension: labelFor(dimension),
        values: filter.ids.map((id) => valuesFor(dimension).find((item) => item.id === id)?.label ?? id).join(', '),
      }),
    )
  }
  return lines.length === 0 ? [t('wizard.review.sourceAnyDims')] : lines
}

function policyTitle(t: (key: string) => string, copy: 'applyAutomatic' | 'applySuggest' | 'applyManual'): string {
  if (copy === 'applyAutomatic') return t('wizard.policy.applyAutomatic')
  if (copy === 'applySuggest') return t('wizard.policy.applySuggest')
  return t('wizard.policy.applyManual')
}

function policyHint(t: (key: string) => string, copy: 'applyAutomatic' | 'applySuggest' | 'applyManual'): string {
  if (copy === 'applyAutomatic') return t('wizard.policy.applyAutomaticHint')
  if (copy === 'applySuggest') return t('wizard.policy.applySuggestHint')
  return t('wizard.policy.applyManualHint')
}

function driverDimensionLabel(t: (key: string) => string, dimension: string | undefined): string {
  if (dimension === 'location') return t('rules.definition.filters.location')
  if (dimension === 'class') return t('rules.definition.filters.class')
  if (dimension === 'project') return t('rules.definition.filters.project')
  if (dimension === 'subsidiary') return t('rules.definition.filters.subsidiary')
  if (dimension?.startsWith('extra:')) return dimension.slice('extra:'.length)
  return t('rules.definition.filters.department')
}

function splitReview(
  t: (key: string, values?: Record<string, string>) => string,
  draft: WizardDraft,
  driver: WizardDriver | null,
  percents: string[],
): string {
  if (draft.splitKind === 'driver') {
    return t('wizard.review.splitDriver', { driver: driver ? `${driver.key} · ${driver.name}` : draft.driverId })
  }
  if (draft.splitKind === 'percent') {
    return t('wizard.review.splitPercent', { percents: percents.map((value) => `${value}%`).join(' / ') })
  }
  return t('wizard.review.splitRatio', {
    weights: filledTargets(draft).map((row) => trimDecimal(row.weight)).join(' : '),
    percents: percents.map((value) => `${value}%`).join(' / '),
  })
}
